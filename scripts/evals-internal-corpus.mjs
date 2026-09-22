#!/usr/bin/env node
/**
 * evals-internal-corpus — the INTERNAL evals corpus: five wicked repos, each at a pinned prior
 * release tag, with an ACTION window of real commits behind it. For testing the evals machinery
 * and OUR doctrine rules (plane boundaries, event grammar, graph invariants, storage doctrine) —
 * rules that actually apply to these repos, which third-party repos structurally cannot exercise.
 * Never shipped in the product: a user evals their OWN policies and memories against their OWN
 * actions (core#397); this corpus is how we test that machinery on ourselves.
 *
 * # The pin is the constant
 *
 * `e2e/corpus/wicked-internal-corpus.json` names, per repo, the tag (the constant a human sets),
 * the commit it resolved to (recorded once, committed), and the action window
 * `action_window_from_tag..tag` chosen by the window rule below. Moving a tag is a deliberate PR:
 * edit `tag`, run `pin`, commit the re-resolved file. `check` fails closed when a tag on disk no
 * longer resolves to the recorded sha (a moved or re-cut tag), and `materialize` / `samples`
 * refuse to work from a checkout whose shas do not match the pin — a sample set derived from
 * the wrong history would be silently incomparable.
 *
 * # Window rule (≥ 50 commits, capped at 180 days)
 *
 * Five releases back is too thin on the fast-cutting repos (measured 2026-09-08: estate 12 / crew
 * 12 / studio 15 commits vs garden 108 / interactive 109). So: walk release tags (`vX.Y.Z`,
 * version order) back from the constant until the range `from..tag` holds at least
 * `window_rule.min_commits` (default 50) commits; never walk past a tag older than
 * `window_rule.max_age_days` (default 180) before the constant tag's own commit date. If the floor
 * cannot be met inside the cap, the oldest tag inside it is taken and the shortfall is recorded in
 * `notes` — never widened past the cap. Both bounds are measured against the pinned tag's date,
 * not today's, so re-running `pin` on an unchanged tag is a no-op.
 *
 * # Modes
 *
 *   node scripts/evals-internal-corpus.mjs pin                 re-resolve shas + windows into the pin
 *   node scripts/evals-internal-corpus.mjs check               tags still resolve to the pinned shas
 *   node scripts/evals-internal-corpus.mjs materialize <dir>   git-archive each tag → <dir>/<repo>@<tag>/
 *   node scripts/evals-internal-corpus.mjs samples <dir>       one EvalSample per window commit → <dir>/samples.json
 *   node scripts/evals-internal-corpus.mjs run <dir>           ingest the doctrine seed + eval the samples (needs wicked-core)
 *
 * Common flags: `--pin <file>` (default e2e/corpus/wicked-internal-corpus.json), `--source-root
 * <dir>` (where the sibling checkouts live — `<root>/<repo>`; default `$WICKED_SOURCE_ROOT`, else
 * this repo's parent dir), `--known-bad <file>` (samples; MUST exist — an empty allowlist is
 * `{"samples": {}}`, a missing or malformed file is an error, never "no bad commits"), `--rules
 * <dir>` (run). The source checkouts are READ-ONLY to this script: only `git rev-parse` / `tag` /
 * `log` / `rev-list` / `archive` run against them — no fetch, no checkout, no worktree add.
 *
 * # Fail-closed posture (what each mode refuses)
 *
 *   - Every mode: a pinned `repo` that is not ONE safe path segment (`SAFE_SEGMENT_RE`, never `.`,
 *     `..`, a separator or an absolute path) is rejected at read time, before any fs operation —
 *     it is joined under the source root AND the materialize root.
 *   - `check` (and every mode that derives): a checkout with INCOMPLETE history is refused by name
 *     — `git rev-parse --is-shallow-repository` = true or a `$GIT_DIR/shallow` file
 *     (`shallowEvidence`). A shallow clone can resolve BOTH pinned tags (a depth-1 clone plus a
 *     depth-1 fetch of the from-tag) while the commits between them are simply not there: the
 *     window would derive fewer samples under the unchanged pin identity. `samples` additionally
 *     compares each repo's derived window commit count AND sample count with the `commits` the
 *     pin recorded from `rev-list --count` (a field `pin_hash` deliberately does not cover: it is
 *     derived, and the real count comes from git — a mismatch is a DriftError naming both numbers,
 *     never a smaller sample set published as the pin's).
 *   - `check` (and every mode that derives): a checkout carrying git REPLACEMENT refs
 *     (`refs/replace/*`, `replaceRefs`) is refused by name (`replace-refs-present`). A replacement
 *     makes git read another object wherever a sha is named: a window commit's message and tree
 *     can be swapped for other content while its parents, both tag shas and `rev-list --count`
 *     stay exactly the pin's — derived actions change under the unchanged pin identity. Belt and
 *     braces: EVERY git the script runs is replacement-blind (`--no-replace-objects` on the command
 *     line AND `GIT_NO_REPLACE_OBJECTS=1` in the child env — `gitRaw`), so even a checkout that
 *     slipped past the refusal derives from the immutable objects; a pin must be derivable from the
 *     immutable history alone.
 *   - `materialize`: works only on direct children of the REALPATH of `<dir>`; an existing entry
 *     that is a symlink, or resolves outside that root, is refused before anything is removed or
 *     extracted; the transient archive lives in a private mkdtemp dir, never at a predictable name.
 *     The whole step runs under `<dir>/.materialize.lock` (a held lock is a refusal — two
 *     materializations never interleave). Every repo is extracted AND verified into a private
 *     staging dir beside its destination (`.<repo>@<tag>.staging-<generation>`); only when EVERY
 *     repo verified are the trees swapped into place (old → `.<repo>@<tag>.prev-<generation>`,
 *     staging → destination) and the receipt published; ONLY THEN are the `.prev` backups removed
 *     — every backup is kept until the receipt is on disk. The receipt is INVALIDATED BEFORE the
 *     first tree moves: an in-progress marker (`.materialize.inprogress-<generation>`) is
 *     published and the previous `materialized.json` is moved aside to
 *     `materialized.json.prev-<generation>`, so between any two renames there is NO receipt at
 *     `materialized.json` — a process killed mid-swap leaves incomplete trees beside no receipt,
 *     never beside a stale success receipt. Any failure before the swap removes the staging dirs
 *     and leaves the previous trees AND `materialized.json` exactly as they were. Any failure
 *     DURING the swap or the receipt write rolls the swap back (`rollbackSwap`: each `.prev`
 *     restored to its destination, partial destinations and staging removed, a torn receipt tmp
 *     removed) so the destinations are the previous trees again, byte for byte, and the previous
 *     receipt is restored — it comes back ONLY after a complete rollback; if the rollback itself
 *     fails, every receipt is REMOVED (no receipt may describe a damaged tree), the marker stays
 *     and the error names both faults. On EVERY start (`inspectMaterializeRoot`, under the lock)
 *     a surviving marker, a `.prev-*` tree or a moved-aside receipt the current receipt does not
 *     account for is DAMAGE: `materialize` repairs it (the `.prev` trees rolled back — a swapped-in
 *     tree replaced by its backup, a hole filled — staging, marker and previous receipt removed,
 *     nothing trusted until this run publishes) and then re-extracts; a reader
 *     (`readMaterializeReceipt(dir, pin)`) refuses a damaged root by name with that repair as the
 *     hint, and trusts a receipt ONLY as the materialization of the selected pin: its `pin_hash`
 *     and `generation` must be there and be the pin's, its `repos[]` must be exactly the pinned
 *     repos at their tag + sha, and every `path` must BE `<root>/<repo>@<tag>` — present, not a
 *     symlink, a directory, realpath-equal (a foreign path, a link, a file or an extra/missing
 *     repo is a named refusal, never "clean" — codex round 6). A `tar` that fails or cannot be
 *     spawned during extraction is a `ToolError` (exit 1), not a usage error (Copilot). A
 *     marker beside a receipt of ITS generation is a torn CLEANUP (the publish landed) and is
 *     finished; stale `.staging-*` alone is debris of a torn extraction and is removed. A receipt
 *     that describes a tree which is no longer there is removed, so a receipt never outlives the
 *     output it describes. Test-only fault points (`EVALS_CORPUS_FAULT`, honoured under vitest /
 *     NODE_ENV=test only) prove the rollback at the n-th swap, the receipt write and the rollback,
 *     and SIGKILL the process between the n-th repo's two renames or right after the receipt landed.
 *     The extracted tree must EQUAL the committed tree: the operator's global/system git
 *     attributes are pinned away for the archive (`-c core.attributesFile=<empty file>`,
 *     `GIT_ATTR_NOSYSTEM=1`, never `--worktree-attributes`), and every `git ls-tree -r -z` entry is
 *     verified present with its blob id after extraction (nothing missing, substituted or extra) —
 *     an `export-ignore`/`export-subst` from a source git offers no override for
 *     (`$GIT_DIR/info/attributes`, the commit's own `.gitattributes`) is a named refusal, never a
 *     different tree recorded as the pin. The receipt carries each repo's `tree_sha`.
 *   - `samples`: `git log` runs with an explicit, complete configuration (`GIT_LOG_CONFIG` + the
 *     command-line twins) so identical pins derive byte-identical samples regardless of the
 *     operator's git config (rename detection, order file, quoting, output encoding, signatures);
 *     paths are read NUL-delimited (`-z`) and never trimmed — a leading/trailing space, a tab, a
 *     quote, a backslash or a newline in a filename is the real name, and the steering-type
 *     inference sees the real path.
 *   - `samples` publication is atomic: samples.json then samples.meta.json via tmp+rename under a
 *     `.samples.lock`, one `generation` stamped per publication; `pin` and `materialize` publish
 *     their files the same way. A partial write is never readable as complete.
 *   - every sample is validated by the ROUTE's own validator (`packages/crew/src/api/eval-sample.js`
 *     `EvalSampleSchema` — the module `POST /testing/corpora/import` parses with; there is no
 *     hand mirror in this script) plus the engine's steering-type vocabulary.
 *   - `run`: verifies samples.meta.json against samples.json (`samples_hash`) AND the selected pin
 *     (`pin_hash`) BEFORE probing the engine, then stages EXACTLY those samples in a fresh private
 *     temp corpus dir (the engine loads every *.json in the dir it is given — a shared dir could
 *     smuggle unpinned samples in). The engine is resolved ONCE (`resolveExecutable`) with the
 *     OS's own search semantics — every `PATH` entry in order, an EMPTY entry being the current
 *     directory exactly as execvp reads it, `PATHEXT` on Windows, an executable REGULAR file
 *     required — and EVERY spawn (`--version`, `rules ingest`, `rules list`, `rules eval`) uses
 *     that absolute path, never the bare name: the file hashed into the provenance is the file
 *     that ran (and it is hashed again after the run — a binary replaced underneath is a tool
 *     failure, never a report attributed to either build). ONLY true absence — nothing on the
 *     search path names the executable (ENOENT; ENOTDIR for a PATH entry that is a file) — is the
 *     documented SKIP; a lookup that fails any other way (`stat` EACCES on a PATH directory, EIO,
 *     a failing realpath) is a tool failure, because which file a spawn would run cannot be
 *     determined (codex round 6); a resolved file that will not execute (no execute bit, a
 *     missing interpreter) and any answer to `--version` but a clean one fail the run. The engine's report is VERIFIED before
 *     publication (`verifyEngineReport`): exactly one result per staged sample (the same id set —
 *     no duplicate, no extra, none missing), every row with a `sample.id`, a `verdict` from the
 *     engine's set (`ENGINE_VERDICTS`) and a `fired` array of rule ids, echoing its staged
 *     sample's description/kind/steering_type, and a `summary` that IS the rows' tally (total =
 *     rows; caught/gaps/false_positives = the verdict counts). Every row must also be CONSISTENT
 *     with its sample's kind (evals.rs `evaluate_sample`): `expected` = deny for a bad sample /
 *     allow for a good one; a good sample is `caught` or `false_positive`, never `gap` (a gap is a
 *     BAD behavior nothing caught); a bad sample is `caught` or `gap`, never `false_positive`; and
 *     `fired` is non-empty exactly when a blocking verdict fired (caught-on-bad,
 *     false_positive-on-good) — deny-dominates, the verdict and the fired set agree. The report's
 *     `degraded` must be PRESENT (null, or `facet-only`); `rule_coverage` is either ABSENT (an
 *     engine predating core #394 — printed as such) or a well-formed `{ exercised, unexercised[]
 *     }` — `null` is malformed and refused before publication — that RECONCILES with the rows
 *     (evals.rs `rule_coverage`: a rule is exercised when ANY evaluated claim fired it, blocking
 *     or not, while a row's `fired` is the blocking subset): no id may be both fired and
 *     `unexercised`, `exercised` is at least the number of distinct ids the rows' `fired` name
 *     (more only when a non-blocking effect fired), `unexercised` holds no duplicate, and
 *     `recall_only`, when present, is a non-negative integer. Anything else is a named tool
 *     failure and nothing is published — an empty, partial or impossible report is never recorded
 *     as an evaluation of the full corpus. A valid all-gap report (BAD samples nothing caught)
 *     passes: gaps are findings. Every row is then stamped with its staged sample's `payload_hash`.
 *   - `run` publishes report.json + report.meta.json as ONE verifiable generation under a
 *     `.report.lock`: both carry the `generation`, the meta carries `report_sha256` over the
 *     published report bytes, and `readPublishedReport()` refuses a pair that does not verify (a
 *     torn publication or a foreign report) with a named error. The meta is complete provenance:
 *     engine version + build identity (realpath + sha256 of the executable that was spawned), the
 *     rule-snapshot identity (`rules_identity.method` says how: `engine-list` = the canonical hash
 *     of every rule `rules list --include-retired --json` read back from the temp rules db before
 *     it is deleted; `seed-dir` = the canonical hash of the seed directory's file contents, used
 *     only when the engine has no such command — recorded, never silent), `pin_hash`,
 *     `samples_hash`, `corpus_name`.
 *
 * Runs on plain node. Its one import beyond node's builtins is crew's shared eval-sample module
 * (zod) — the route's own validator and the sample payload-identity hash, ONE spelling.
 *
 * Exit codes: 0 ok / skipped-with-reason, 1 drift / refusal / tool failure, 2 usage or IO error.
 * Eval GAPS are findings, not failures — `run` exits 0 on a report full of gaps.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The route's OWN sample validator + the sample payload-identity hash — imported from crew's
// source tree (plain ESM JS by design, so this script needs no build step): one spelling for the
// route, the offline comparison and this derivation.
import { EvalSampleSchema, samplePayloadHash } from '../packages/crew/src/api/eval-sample.js';

/** This repo's root (the script lives in `<root>/scripts/`). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The committed pin — THE constant. */
export const DEFAULT_PIN_PATH = join(REPO_ROOT, 'e2e', 'corpus', 'wicked-internal-corpus.json');
/** The team's allowlist of window commits that are BAD behavior (everything else is `good`). */
export const DEFAULT_KNOWN_BAD_PATH = join(REPO_ROOT, 'e2e', 'corpus', 'known-bad.json');
/** A release tag: plain semver with a `v` prefix. `api-types-v0.25.0`-style package tags and
 *  `wicked-garden-v12.22.0`-style legacy tags are NOT release tags of the repo. */
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;
/** The window rule's defaults (a pin may carry its own `window_rule`). */
export const DEFAULT_WINDOW_RULE = Object.freeze({ min_commits: 50, max_age_days: 180 });
/** Sample ids are `<repo>@<sha prefix>`: a fixed prefix length, never git's ambiguity-dependent
 *  `--short`, so the id of a commit is the same on every machine at every repo size. */
export const SHORT_SHA_LEN = 12;
/** A pinned `repo` is ONE path segment — it is joined under the source root and the materialize
 *  root, so a separator, `.`/`..`, an absolute path or a NUL is rejected at READ time, before any
 *  filesystem operation could act on the joined path. */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
/** The publication lock `samples` holds while it renames samples.json + samples.meta.json into
 *  place — two concurrent derivations into one dir are refused, never interleaved. */
export const SAMPLES_LOCK = '.samples.lock';
/** The publication lock `run` holds while it renames report.json + report.meta.json into place. */
export const REPORT_LOCK = '.report.lock';
/** The lock `materialize` holds for its WHOLE step (extract, verify, swap, receipt) — two
 *  materializations into one root never interleave; the second is refused naming the holder. */
export const MATERIALIZE_LOCK = '.materialize.lock';
/** The materialize receipt, beside the trees it describes. */
export const MATERIALIZE_RECEIPT = 'materialized.json';
/** The marker `materialize` publishes beside the receipt BEFORE the first tree moves
 *  (`.materialize.inprogress-<generation>`) and removes LAST, after the backups are gone: while it
 *  exists a swap is in flight or was torn — no receipt at `materialized.json` may be trusted unless
 *  it carries the marker's own generation (then only the cleanup was torn). See
 *  `inspectMaterializeRoot`. */
export const MATERIALIZE_INPROGRESS_PREFIX = '.materialize.inprogress-';
/** A publication stamp (`newGeneration`): `YYYYMMDD-HHMMSS-<8 hex>`. */
export const GENERATION_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
/** The engine's verdict vocabulary (evals.rs `Verdict`; api-types `GovernanceEvalResult.verdict`)
 *  — a report row carrying anything else is refused, never published. */
export const ENGINE_VERDICTS = Object.freeze(['caught', 'gap', 'false_positive']);
/** The engine's `degraded` vocabulary (evals.rs `DEGRADED_FACET_ONLY`; api-types
 *  `GovernanceEvalReport.degraded: 'facet-only' | null`) — the key is ALWAYS serialized by the
 *  engine (an `Option` without `skip_serializing_if`), so an absent key is a malformed report. */
export const ENGINE_DEGRADED_MODES = Object.freeze(['facet-only']);
/** The TEST-ONLY fault hook (see `injectedFault`): `EVALS_CORPUS_FAULT=<point>[,<point>…]`. */
export const FAULT_ENV = 'EVALS_CORPUS_FAULT';
/** verdict → the `summary` field that counts it (the engine's roll-up spelling). */
const SUMMARY_FIELD_OF_VERDICT = Object.freeze({ caught: 'caught', gap: 'gaps', false_positive: 'false_positives' });
/** What `materialize` pins for every `git archive` call (recorded in the receipt). */
export const ARCHIVE_ATTRIBUTES_NOTE = Object.freeze({
  pinned: ['core.attributesFile=<empty file>', 'GIT_ATTR_NOSYSTEM=1', 'no --worktree-attributes'],
  verified: 'every `git ls-tree -r -z <commit>` entry present with its blob id after extraction; nothing extra',
});
/**
 * The git configuration the sample derivation READS, pinned explicitly (`-c` outranks every config
 * file: system, global, repo-local) so identical pins derive byte-identical samples on every
 * machine. Each key changes `git log --name-only` output when left to the local config:
 *   core.quotePath          true ⇒ non-ASCII paths come back quoted + octal-escaped
 *   diff.renames            true (git's default since 2.9) ⇒ a rename shows ONLY its new path, by a
 *                           content-similarity heuristic bounded by diff.renameLimit; pinned OFF: a
 *                           rename touches BOTH paths, no heuristic
 *   diff.relative           true ⇒ paths relative to the cwd instead of the tree root
 *   diff.mnemonicPrefix /   patch-header knobs — no effect on --name-only; pinned so the enumerated
 *   diff.noprefix           diff-output surface is complete
 *   log.showSignature       true ⇒ signature-verification lines are printed into the record stream
 *   log.follow              true ⇒ --follow semantics whenever a single path is given
 *   i18n.logOutputEncoding  re-encodes subject/body bytes on output
 * The command-line twins (`--no-renames`, `--no-show-signature`, `--no-ext-diff`, `-O/dev/null` —
 * git's documented cancel for diff.orderFile, mapped to NUL by git on Windows — and
 * `--ignore-submodules=none`, `--diff-merges=first-parent`) ride alongside in `windowCommits`.
 */
export const GIT_LOG_CONFIG = Object.freeze([
  'core.quotePath=false',
  'diff.renames=false',
  'diff.relative=false',
  'diff.mnemonicPrefix=false',
  'diff.noprefix=false',
  'log.showSignature=false',
  'log.follow=false',
  'i18n.logOutputEncoding=UTF-8',
]);
/** The seven steering types (wicked-governance STEERING_TYPES — the engine rejects any other). */
export const STEERING_TYPES = Object.freeze([
  'architecture',
  'development',
  'security',
  'testing',
  'operations',
  'compliance',
  'design-ux',
]);
/** The steering type a sample gets when the touched paths do not say otherwise. */
export const DEFAULT_STEERING_TYPE = 'development';
/** Where `run` looks for the doctrine seed corpus (wicked-core's frontmattered steering docs)
 *  unless `--rules` says otherwise — relative to the source root. */
export const DEFAULT_RULES_SEED_REL = join('wicked-core', 'crates', 'wicked-governance', 'seed', 'corpus');
/** The engine CLI `run` looks for on PATH. */
export const CORE_BIN = 'wicked-core';

/**
 * The EXPLICIT path → steering-type table. One file is classified by the FIRST row it matches
 * (a `segments` hit is a whole directory-segment match anywhere above the file name; `files`
 * matches the file name exactly; `suffixes` matches the end of the file name). A sample takes a
 * type only when a STRICT MAJORITY of its touched files classify to that one type; otherwise it
 * is `development` — the honest "unsure", never a guess from words in a docs path. Docs, sites and
 * READMEs are deliberately unclassified: a Markdown edit is not evidence of design-ux or
 * compliance behavior.
 */
export const PATH_TYPE_TABLE = Object.freeze([
  {
    type: 'testing',
    segments: ['tests', 'test', '__tests__', 'e2e', 'scenarios', 'fixtures'],
    suffixes: ['.test.ts', '.test.tsx', '.test.js', '.test.mjs', '.spec.ts', '.spec.tsx', '_test.py', '_test.rs'],
  },
  {
    type: 'operations',
    segments: ['.github', 'ci', 'deploy', 'docker', 'release'],
    files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'Makefile', 'renovate.json'],
  },
  {
    type: 'security',
    segments: ['auth', 'security', 'permissions', 'secrets'],
    files: ['SECURITY.md'],
  },
  {
    type: 'compliance',
    segments: ['compliance'],
    files: ['LICENSE', 'LICENSE.md', 'NOTICE', 'CODE_OF_CONDUCT.md'],
  },
  {
    type: 'architecture',
    segments: ['adr', 'adrs', '.product'],
    files: ['ARCHITECTURE.md', 'TARGET-ARCHITECTURE.md'],
  },
  {
    type: 'design-ux',
    segments: ['components', 'styles', 'ui'],
    suffixes: ['.css', '.scss'],
  },
]);

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_USAGE = 2;
const MS_PER_DAY = 86_400_000;
/** `git archive` of the largest pinned repo is tens of MB; give the tar a generous ceiling. */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

export class UsageError extends Error {}
/** A fail-closed refusal that is not drift: a containment, lock or published-identity check said
 *  no. Exit 1, like drift — the operator has something to fix before the mode may run. */
export class RefusalError extends Error {}
/** The source checkouts no longer match the pin (a moved or re-cut tag). Exit 1. */
export class DriftError extends Error {}
/** A tool this script drives (`tar`, the engine) could not be spawned or failed: an operational
 *  fault the operator has to fix, not a usage error — exit 1 like drift and refusal (Copilot on
 *  #475: a `tar` failure inside `materialize` surfaced as a plain Error, i.e. exit 2). */
export class ToolError extends Error {}

/** One safe path segment (see `SAFE_SEGMENT_RE`) — never `.` or `..`. */
export function isSafeSegment(name) {
  return typeof name === 'string' && SAFE_SEGMENT_RE.test(name) && name !== '.' && name !== '..';
}

/** A publication stamp: `YYYYMMDD-HHMMSS-<8 hex>` — filename-safe on every platform. */
function newGeneration() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${t}-${randomBytes(4).toString('hex')}`;
}

/** Publish a JSON file atomically: write `<path>.<generation>.tmp` beside it, then rename into
 *  place (an atomic replace on POSIX and Windows). A reader sees the old file or the new one,
 *  never a truncated one. Returns the exact text written (what a content hash must cover). */
function publishJson(path, value, generation = newGeneration()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${generation}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return text;
}

/**
 * Run `fn(generation)` holding `lockPath` (exclusive create — a held lock is a refusal naming the
 * holder, never an interleaving), then release the lock however `fn` ends. One `generation` per
 * publication; the lock file records `pid` + generation for the operator who finds it stale.
 */
function withPublicationLock(lockPath, what, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const generation = newGeneration();
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') {
      let holder = '';
      try {
        holder = readFileSync(lockPath, 'utf8').trim();
      } catch {
        /* an unreadable lock is still a held lock */
      }
      throw new RefusalError(
        `another \`${what}\` publication holds ${lockPath}${holder === '' ? '' : ` (${holder})`} — refusing to interleave; if no ${what} is running, remove the lock and retry`,
      );
    }
    throw err;
  }
  // From here the lock is OURS: release it however publication ends.
  try {
    writeFileSync(fd, `pid ${process.pid} generation ${generation}\n`, 'utf8');
    closeSync(fd);
    fd = undefined;
    return fn(generation);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

function git(cwd, args, opts = {}) {
  return gitRaw(cwd, args, opts).trimEnd();
}

/**
 * `git` output VERBATIM — for NUL-delimited listings, where a trailing byte is data, never noise.
 * EVERY git the script runs goes through here, REPLACEMENT-BLIND: `--no-replace-objects` on the
 * command line AND `GIT_NO_REPLACE_OBJECTS=1` in the child env (either alone suffices — both, so
 * neither a wrapper nor an alias can drop one). A `refs/replace/<sha>` ref makes git read another
 * object wherever `<sha>` is named: a window commit's message and tree can be swapped for other
 * content while its parents, the tag shas and `rev-list --count` stay exactly the pin's. The pin,
 * the checks, the derivation and the archive must see the immutable objects only (`checkPin`
 * additionally REFUSES a checkout that carries any such ref — `replaceRefs`).
 */
function gitRaw(cwd, args, opts = {}) {
  const { env: baseEnv = process.env, ...rest } = opts;
  return execFileSync('git', ['-C', cwd, '--no-replace-objects', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...baseEnv, GIT_NO_REPLACE_OBJECTS: '1' },
    ...rest,
  });
}

/**
 * Is the TEST-ONLY fault `point` armed? `EVALS_CORPUS_FAULT=<point>[,<point>…]`, honoured ONLY
 * under vitest / NODE_ENV=test (`process.env.VITEST` = "true" or NODE_ENV = "test"); inert
 * everywhere else, so an operator's stray variable can never fault a real materialization.
 */
function faultArmed(point) {
  return armedFaults().includes(point);
}

/** The TEST-ONLY fault points `EVALS_CORPUS_FAULT` arms — always empty outside vitest / NODE_ENV=test. */
function armedFaults() {
  if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') return [];
  return (process.env[FAULT_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The TEST-ONLY lookup fault (`armedFaults`): `lookup-<syscall>:<code>` makes `resolveExecutable`'s
 * `<syscall>` (`stat` | `access`) fail with errno `<code>` (`EIO`, `EACCES`, …) — the filesystem
 * faults codex round 6 injected, which the resolver used to swallow as "not installed" (the
 * exit-zero SKIP). Inert outside the test env like every other point.
 */
function injectedLookupFault(syscall) {
  const prefix = `lookup-${syscall}:`;
  const armed = armedFaults().find((p) => p.startsWith(prefix));
  if (armed !== undefined) {
    const code = armed.slice(prefix.length);
    throw Object.assign(new Error(`injected ${code} at ${syscall} (${FAULT_ENV}, test hook)`), { code, syscall });
  }
}

/**
 * The TEST-ONLY fault hook (`faultArmed`): the named step THROWS — `swap:<n>` (the n-th repo's
 * staging → destination rename, after its destination was moved to `.prev`), `receipt` (the
 * receipt write, after every swap), `rollback` (the rollback itself — the double fault).
 */
function injectedFault(point) {
  if (faultArmed(point)) throw new Error(`injected fault at ${point} (${FAULT_ENV}, test hook)`);
}

/**
 * The TEST-ONLY termination hook (`faultArmed`): SIGKILL THIS process — no `catch`, no `finally`,
 * the lock stays, exactly like a real crash. `kill-between-swaps:<n>` fires between the n-th
 * repo's two renames (its destination already moved to `.prev`, its staging not yet in place — the
 * torn swap codex round 5 described); `kill-after-receipt` right after the receipt landed and
 * before the backups are removed (a torn cleanup).
 */
function injectedKill(point) {
  if (faultArmed(point)) process.kill(process.pid, 'SIGKILL');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Codepoint order on `repo` — deterministic on every machine (`localeCompare` is locale-bound). */
function byRepo(a, b) {
  return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** The first few of a list, JSON-quoted, with the total when it was cut — for refusal messages. */
function listSome(xs, n = 5) {
  return xs.slice(0, n).map((p) => JSON.stringify(p)).join(', ') + (xs.length > n ? `, … (${xs.length} total)` : '');
}

/** The pin's content identity: the sorted (repo, tag, sha, from tag, from sha) tuples. Dates,
 *  counts, notes and the description are for humans and excluded. */
export function pinHash(repos) {
  const canonical = JSON.stringify(
    [...repos]
      .sort(byRepo)
      .map(({ repo, tag, commit_sha, action_window_from_tag, action_window_from_sha }) => ({
        repo,
        tag,
        commit_sha,
        action_window_from_tag,
        action_window_from_sha,
      })),
  );
  return sha256(canonical);
}

/** The samples' content identity: sha256 over the canonical (compact, key-ordered as written) JSON. */
export function samplesHash(samples) {
  return sha256(JSON.stringify(samples));
}

/** The source checkout of `repo`: `<sourceRoot>/<repo>`, which must be a git repo. */
function sourceCheckout(sourceRoot, repo) {
  const dir = join(sourceRoot, repo);
  if (!existsSync(join(dir, '.git'))) {
    throw new UsageError(`no source checkout for ${repo} at ${dir} (expected <source-root>/<repo>/.git)`);
  }
  return dir;
}

/**
 * Why `checkout` has INCOMPLETE history, as a list of evidence lines (empty = a full clone):
 * `git rev-parse --is-shallow-repository` answering `true`, and/or a `shallow` file in the
 * checkout's git dir (`rev-parse --git-dir`, so a worktree's or a gitfile's dir is the one looked
 * at). Either alone is enough — a shallow clone resolves the pinned tags exactly like a full one
 * (a depth-1 clone plus a depth-1 fetch of the from-tag) while the commits between them are
 * missing, and `from..tag` would then walk a truncated window under the unchanged pin identity.
 */
export function shallowEvidence(checkout) {
  const evidence = [];
  if (git(checkout, ['rev-parse', '--is-shallow-repository']) === 'true') evidence.push('`git rev-parse --is-shallow-repository` says true');
  const shallowFile = join(resolve(checkout, git(checkout, ['rev-parse', '--git-dir'])), 'shallow');
  if (existsSync(shallowFile)) evidence.push(`${shallowFile} exists`);
  return evidence;
}

/**
 * The checkout's git REPLACEMENT refs (`refs/replace/<sha>`), as the replaced shas' first
 * `SHORT_SHA_LEN` chars; empty = none. A ref LISTING (`for-each-ref`), so `--no-replace-objects`
 * does not hide them — it hides only their effect. Any such ref is a refusal in `pin` and `check`:
 * a pin must be derivable from the immutable history alone (see `gitRaw`).
 */
export function replaceRefs(checkout) {
  const out = git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/replace/']);
  return out === '' ? [] : out.split('\n').map((ref) => ref.replace(/^refs\/replace\//, '').slice(0, SHORT_SHA_LEN));
}

/** Resolve a tag to its COMMIT sha (annotated tags peel), or null when the tag does not exist. */
export function resolveTag(checkout, tag) {
  try {
    return git(checkout, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch {
    return null;
  }
}

/** `for-each-ref` row: tag name, the PEELED commit sha (annotated tags deref through `*`), and
 *  that commit's committer date as `YYYY-MM-DD` — tab-separated, one row per tag. */
const TAG_TABLE_FORMAT =
  '%(refname:short)%09' +
  '%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%09' +
  '%(if)%(*objectname)%(then)%(*committerdate:short)%(else)%(committerdate:short)%(end)';

/**
 * Every tag of the checkout with its peeled commit sha and commit date, from ONE git call, in
 * version-descending order (`Map` insertion order): `tag → { sha, date }`. The window walk over
 * N release tags then costs N `rev-list --count` calls instead of 3N round-trips.
 */
export function tagTable(checkout) {
  const table = new Map();
  for (const row of git(checkout, ['for-each-ref', '--sort=-v:refname', `--format=${TAG_TABLE_FORMAT}`, 'refs/tags']).split('\n')) {
    if (row === '') continue;
    const [tag, sha, date] = row.split('\t');
    table.set(tag, { sha, date });
  }
  return table;
}

/** Release tags OLDER than `tag` in version order (nearest first). Fails loud if `tag` is not a
 *  release tag of the checkout — the constant must be one. */
export function releaseTagsBefore(table, tag, checkout) {
  const tags = [...table.keys()].filter((t) => RELEASE_TAG_RE.test(t));
  const at = tags.indexOf(tag);
  if (at === -1) {
    throw new UsageError(`${tag} is not a release tag of ${checkout} (release tags match ${RELEASE_TAG_RE})`);
  }
  return tags.slice(at + 1);
}

/**
 * Apply the window rule for one repo: walk release tags back from `tag` until `from..tag` holds
 * `min_commits`, never past `max_age_days` before the tag's commit date. Returns the chosen
 * `from` (tag, sha, date, commit count) and the note that explains the choice.
 */
export function resolveWindow(checkout, tag, rule, table = tagTable(checkout)) {
  // Guard BEFORE destructuring: a tag missing from the table (a caller's table, or a tag that
  // does not exist) must be a UsageError naming both, never a TypeError on `undefined`.
  const pinned = table.get(tag);
  if (pinned === undefined) {
    throw new UsageError(`${tag}: tag does not exist in ${checkout} (not in its tag table) — a window can only open from an existing release tag`);
  }
  const { sha: tagSha, date: tagDate } = pinned;
  const oldestAllowed = Date.parse(tagDate) - rule.max_age_days * MS_PER_DAY;
  let chosen = null;
  let walked = 0;
  let stoppedAtCap = null;
  for (const candidate of releaseTagsBefore(table, tag, checkout)) {
    const { sha, date } = table.get(candidate);
    if (Date.parse(date) < oldestAllowed) {
      stoppedAtCap = `${candidate} (${date})`;
      break;
    }
    walked += 1;
    const commits = Number(git(checkout, ['rev-list', '--count', `${sha}..${tagSha}`]));
    chosen = { tag: candidate, sha, date, commits };
    if (commits >= rule.min_commits) break;
  }
  if (chosen === null) {
    throw new UsageError(
      `${tag}: no release tag inside ${rule.max_age_days} days before ${tagDate} to open an action window from` +
        (stoppedAtCap ? ` (the nearest, ${stoppedAtCap}, is past the cap)` : ''),
    );
  }
  const floorMet = chosen.commits >= rule.min_commits;
  const notes = floorMet
    ? `window ${chosen.tag}..${tag} = ${chosen.commits} commits (>= ${rule.min_commits} floor met after walking back ${walked} release tag${walked === 1 ? '' : 's'})`
    : `SHORTFALL: window ${chosen.tag}..${tag} = ${chosen.commits} commits < ${rule.min_commits} floor; ` +
      `${chosen.tag} is the oldest release tag inside ${rule.max_age_days} days of ${tagDate}` +
      (stoppedAtCap ? ` (next older ${stoppedAtCap} is past the cap)` : ' (no older release tag exists)') +
      ' — not widened past the cap';
  return { tagDate, from: chosen, notes };
}

/** Read + structurally validate a pin file. */
export function readPin(pinPath) {
  if (!existsSync(pinPath)) throw new UsageError(`no pin at ${pinPath}`);
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (!Array.isArray(pin.repos) || pin.repos.length === 0) throw new UsageError(`${pinPath}: "repos" must be a non-empty array`);
  for (const r of pin.repos) {
    for (const key of ['repo', 'remote', 'tag']) {
      if (typeof r[key] !== 'string' || r[key] === '') throw new UsageError(`${pinPath}: every repo needs a non-empty "${key}"`);
    }
    // `repo` is joined under the source root and the materialize root: anything but one safe
    // segment is rejected HERE, before any mode touches the filesystem with it.
    if (!isSafeSegment(r.repo)) {
      throw new UsageError(
        `${pinPath}: repo ${JSON.stringify(r.repo)} is not a single safe path segment (${SAFE_SEGMENT_RE}, never . or ..) — it is joined under the source and materialize roots`,
      );
    }
    if (!RELEASE_TAG_RE.test(r.tag)) throw new UsageError(`${pinPath}: ${r.repo} tag ${r.tag} is not a release tag (${RELEASE_TAG_RE})`);
  }
  const names = new Set(pin.repos.map((r) => r.repo));
  if (names.size !== pin.repos.length) throw new UsageError(`${pinPath}: duplicate repo entries`);
  return pin;
}

function windowRuleOf(pin) {
  const rule = { ...DEFAULT_WINDOW_RULE, ...(pin.window_rule ?? {}) };
  for (const key of ['min_commits', 'max_age_days']) {
    if (!Number.isInteger(rule[key]) || rule[key] <= 0) throw new UsageError(`window_rule.${key} must be a positive integer`);
  }
  return rule;
}

/** A pin whose `pin_hash` no longer matches its own tuples was hand-edited — refuse to trust it.
 *  A resolved pin also records each window's `commits` (what the derivation is checked against):
 *  a repo without that count is a constants-only file — `pin` has not run. */
function assertPinIntegrity(pin, pinPath) {
  if (typeof pin.pin_hash !== 'string') throw new UsageError(`${pinPath} carries no pin_hash — run \`pin\` first`);
  const expected = pinHash(pin.repos);
  if (pin.pin_hash !== expected) {
    throw new UsageError(
      `pin_hash mismatch: ${pinPath} says ${pin.pin_hash} but its own repos hash to ${expected} — ` +
        'the pin was hand-edited; re-run `pin` (moving a tag is a deliberate PR)',
    );
  }
  for (const r of pin.repos) {
    if (!Number.isInteger(r.commits) || r.commits < 0) {
      throw new UsageError(`${pinPath}: ${r.repo} records no window commit count (\`commits\`) — run \`pin\` first`);
    }
  }
}

/**
 * `pin`: re-resolve every repo's tag and window from the source checkouts and rewrite the pin.
 * The constants read from the existing file are `repo`, `remote`, `tag`, `description` and
 * `window_rule`; everything else is derived. Returns the new pin.
 */
export function buildPin(pinPath, sourceRoot) {
  const constants = readPin(pinPath);
  const rule = windowRuleOf(constants);
  const repos = [...constants.repos].sort(byRepo).map((c) => {
    const checkout = sourceCheckout(sourceRoot, c.repo);
    // A pin resolved over a shallow checkout would record truncated windows and counts by
    // construction (`rev-list --count` stops at the shallow boundary) — refuse before resolving.
    const shallow = shallowEvidence(checkout);
    if (shallow.length > 0) {
      throw new UsageError(`${c.repo}: refusing to pin from a checkout with INCOMPLETE history (${shallow.join('; ')}) — unshallow it (git fetch --unshallow) or use a full clone`);
    }
    // A replacement ref rewrites what a sha resolves to without moving any tag or count: the pin
    // must be derivable from the immutable history alone — refuse before resolving.
    const replaced = replaceRefs(checkout);
    if (replaced.length > 0) {
      throw new UsageError(
        `${c.repo}: refusing to pin from a checkout carrying ${replaced.length} git replacement ref(s) (refs/replace/ for ${replaced.join(', ')}) — a pin must be derivable from the immutable history alone; git replace -d <sha> (or use a clean clone) and retry`,
      );
    }
    const table = tagTable(checkout);
    if (!table.has(c.tag)) throw new UsageError(`${c.repo}: tag ${c.tag} does not exist in ${checkout}`);
    const { tagDate, from, notes } = resolveWindow(checkout, c.tag, rule, table);
    return {
      repo: c.repo,
      remote: c.remote,
      tag: c.tag,
      commit_sha: table.get(c.tag).sha,
      tag_date: tagDate,
      action_window_from_tag: from.tag,
      action_window_from_sha: from.sha,
      action_window_from_date: from.date,
      commits: from.commits,
      notes,
    };
  });
  return {
    description: constants.description,
    release_tag_pattern: RELEASE_TAG_RE.source,
    window_rule: rule,
    repos,
    pin_hash: pinHash(repos),
  };
}

/**
 * `check`: does every pinned tag (and window-from tag) still resolve to its recorded sha, over a
 * COMPLETE, UNREPLACED history? Pure over the git facts — returns per-repo findings so the CLI
 * prints and the tests assert.
 *   drift[] — { repo, reason: 'tag' | 'from' | 'missing' | 'shallow' | 'replace-refs-present', detail }
 *   ok[]    — repos whose two shas both match, whose history is not shallow and which carry no
 *             `refs/replace/*` (a replacement changes derived actions under unchanged shas + counts)
 */
export function checkPin(pin, sourceRoot) {
  const drift = [];
  const ok = [];
  for (const r of [...pin.repos].sort(byRepo)) {
    let checkout;
    try {
      checkout = sourceCheckout(sourceRoot, r.repo);
    } catch (err) {
      drift.push({ repo: r.repo, reason: 'missing', detail: err.message });
      continue;
    }
    let clean = true;
    // Shallow FIRST: both tags can resolve on a shallow clone — the history between them is what
    // is missing, and no sha comparison can see that.
    const shallow = shallowEvidence(checkout);
    if (shallow.length > 0) {
      clean = false;
      drift.push({
        repo: r.repo,
        reason: 'shallow',
        detail: `the checkout has INCOMPLETE history (${shallow.join('; ')}) — a pinned window cannot be walked over a shallow clone; unshallow it (git fetch --unshallow) or use a full clone`,
      });
    }
    // Replacement refs: both shas and the count can match the pin EXACTLY while a window commit's
    // message and tree read as something else (every git call here is replacement-blind, but a
    // pin must be derivable from the immutable history alone — a checkout carrying them is refused).
    const replaced = replaceRefs(checkout);
    if (replaced.length > 0) {
      clean = false;
      drift.push({
        repo: r.repo,
        reason: 'replace-refs-present',
        detail: `the checkout carries ${replaced.length} git replacement ref(s) (refs/replace/ for ${replaced.join(', ')}) — a replacement rewrites what a window commit says without moving any tag or count; a pin must be derivable from the immutable history alone: git replace -d <sha> (or use a clean clone) and retry`,
      });
    }
    const tagSha = resolveTag(checkout, r.tag);
    if (tagSha !== r.commit_sha) {
      clean = false;
      drift.push({
        repo: r.repo,
        reason: 'tag',
        detail: `${r.tag} resolves to ${tagSha === null ? 'NOTHING (tag gone)' : tagSha.slice(0, SHORT_SHA_LEN)} != pinned ${r.commit_sha.slice(0, SHORT_SHA_LEN)}`,
      });
    }
    const fromSha = resolveTag(checkout, r.action_window_from_tag);
    if (fromSha !== r.action_window_from_sha) {
      clean = false;
      drift.push({
        repo: r.repo,
        reason: 'from',
        detail: `${r.action_window_from_tag} resolves to ${fromSha === null ? 'NOTHING (tag gone)' : fromSha.slice(0, SHORT_SHA_LEN)} != pinned ${r.action_window_from_sha.slice(0, SHORT_SHA_LEN)}`,
      });
    }
    if (clean) ok.push(r.repo);
  }
  return { drift, ok };
}

/** Fail closed before any derivation: the checkouts must BE the pin. */
function requirePinnedCheckouts(pin, pinPath, sourceRoot) {
  assertPinIntegrity(pin, pinPath);
  const { drift } = checkPin(pin, sourceRoot);
  if (drift.length > 0) {
    const lines = drift.map((d) => `  DRIFT     ${d.repo} — ${d.reason}: ${d.detail}`);
    throw new DriftError(`source checkouts do not match the pin — refusing to derive from the wrong history:\n${lines.join('\n')}`);
  }
}

/**
 * `<root>/<name>` — the ONLY shape `materialize` will remove or write: `root` is already a
 * realpath, `name` is one safe segment (so the join is a direct child — asserted, not assumed),
 * and an existing entry there is neither a symlink nor anything that resolves outside `root`.
 * Refuses (exit 1) otherwise, BEFORE any removal or extraction.
 */
function containedChild(root, name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new RefusalError(`refusing to materialize ${JSON.stringify(name)}: not a single path segment`);
  }
  const path = join(root, name);
  if (dirname(path) !== root || basename(path) !== name) {
    throw new RefusalError(`refusing to materialize ${name}: ${path} is not a direct child of the materialize root ${root}`);
  }
  let entry = null;
  try {
    entry = lstatSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (entry !== null) {
    if (entry.isSymbolicLink()) {
      throw new RefusalError(`refusing to materialize into ${path}: it is a symlink (removing or extracting there would act through it)`);
    }
    const real = realpathSync(path);
    if (real !== path) {
      throw new RefusalError(`refusing to materialize into ${path}: it resolves to ${real}, outside the materialize root ${root}`);
    }
  }
  return path;
}

/**
 * `materialize <dir>`: `git archive` each pinned tag into `<dir>/<repo>@<tag>/` (a fresh tree —
 * an existing one is replaced). Refuses everything when ANY repo's sha does not match the pin.
 *
 * Containment: every entry removed or written is a direct, non-symlink child of the REALPATH of
 * `<dir>` (`containedChild`); `repo` was validated as one safe segment when the pin was read and
 * `tag` matches `RELEASE_TAG_RE` — both re-asserted here, for every name this step may touch
 * (destination, staging, `.prev`), BEFORE anything is extracted. The transient tar lives in a
 * private mkdtemp dir, never at a predictable name beside the destination that a planted symlink
 * could redirect.
 *
 * Publication: the whole step holds `<dir>/.materialize.lock` (`withPublicationLock` — a held
 * lock is a refusal naming the holder; two materializations never interleave). FIRST what a
 * previous materialization left behind is repaired (`inspectMaterializeRoot` / `repairMaterializeRoot`
 * — a torn swap rolled back, a torn cleanup finished, stale staging removed; every `repaired` line
 * goes to `note`). Every repo is then extracted AND verified into a private staging dir beside its
 * destination (`.<repo>@<tag>.staging-<generation>`); the previous trees are not touched until
 * EVERY repo has verified. Then the receipt is INVALIDATED — the in-progress marker
 * (`.materialize.inprogress-<generation>`) is published and the previous `materialized.json` is
 * moved aside to `materialized.json.prev-<generation>` — BEFORE the first tree moves; each tree is
 * swapped into place (old → `.<repo>@<tag>.prev-<generation>`, staging → destination); the receipt
 * that describes exactly these trees is published atomically, stamped with the same `generation`;
 * ONLY THEN are the `.prev` backups and the previous receipt removed, and the marker LAST. So a
 * process killed between any two renames leaves incomplete trees beside NO receipt (the previous
 * one is aside, the new one not yet written) and a marker that names the torn generation; the next
 * start sees DAMAGE, never a stale success receipt. Any failure before the swap removes the staging
 * dirs and leaves the previous trees AND `materialized.json` exactly as they were — an old success
 * receipt never sits beside output the failure damaged, because the failure never reached the
 * output. Any failure DURING the swap or the receipt write is rolled back (`rollbackSwap`, in
 * reverse order: a swapped-in tree is removed and its `.prev` restored, a moved-away destination is
 * restored, staging and a torn receipt tmp are removed) and ONLY THEN is the previous receipt moved
 * back — the destinations are the previous trees again, byte for byte, and the restored receipt
 * describes exactly them; the original error is rethrown. If the rollback itself fails, every
 * receipt is REMOVED — no receipt may describe a damaged tree — the marker stays (the next
 * `materialize` repairs), and a RefusalError names BOTH faults and the `.staging-`/`.prev-<generation>`
 * entries left for the operator. If a receipt describes a tree that is no longer there (a first
 * run never had one; an operator removed one by hand), it is removed: a receipt never outlives the
 * trees it describes.
 *
 * Fidelity: the extracted tree must EQUAL the committed tree. `git archive` honors
 * `export-ignore` / `export-subst` attributes from three sources. The operator's global/system
 * attributes are pinned away for the call (`-c core.attributesFile=<empty file>` — a real empty
 * file, since `/dev/null` is not one on Windows — plus `GIT_ATTR_NOSYSTEM=1`; `--worktree-
 * attributes` is never given). The two sources git offers NO override for, `$GIT_DIR/info/
 * attributes` and the commit's own `.gitattributes`, are caught AFTER extraction by
 * `verifyExtractedTree`: every `git ls-tree -r -z` entry must be present with the same blob id and
 * nothing else may be there — a dropped, substituted or extra file is a named refusal, never a
 * different tree recorded as the pin. Each repo's `tree_sha` rides in the receipt.
 */
export function materialize(pin, pinPath, sourceRoot, outDir, note = () => {}) {
  requirePinnedCheckouts(pin, pinPath, sourceRoot);
  mkdirSync(outDir, { recursive: true });
  // A materialize root reached through a symlink is the operator's choice; everything below is
  // addressed from its RESOLVED path so containment is judged against the real directory.
  const root = realpathSync(outDir);
  return withPublicationLock(join(root, MATERIALIZE_LOCK), 'materialize', (generation) => {
    const receiptPath = containedChild(root, MATERIALIZE_RECEIPT);
    // Phase 0a — what a PREVIOUS materialization left behind, under the lock and before any
    // extraction: a torn swap is rolled back (nothing trusted until this run publishes), a torn
    // cleanup finished, stale staging removed — this run starts from a known root.
    for (const line of repairMaterializeRoot(root, inspectMaterializeRoot(root))) note(line);
    // Phase 0b — every name this step may remove or write, contained and asserted up front.
    const marker = containedChild(root, `${MATERIALIZE_INPROGRESS_PREFIX}${generation}`);
    const receiptPrev = containedChild(root, `${MATERIALIZE_RECEIPT}.prev-${generation}`);
    const plan = [...pin.repos].sort(byRepo).map((r) => {
      if (!isSafeSegment(r.repo) || !RELEASE_TAG_RE.test(r.tag)) {
        throw new RefusalError(`refusing to materialize ${JSON.stringify(`${r.repo}@${r.tag}`)}: repo/tag are not safe path segments`);
      }
      const name = `${r.repo}@${r.tag}`;
      return {
        r,
        name,
        checkout: sourceCheckout(sourceRoot, r.repo),
        dest: containedChild(root, name),
        staging: containedChild(root, `.${name}.staging-${generation}`),
        prev: containedChild(root, `.${name}.prev-${generation}`),
        tree: null,
      };
    });
    // Phase 1 — extract + verify EVERY repo into its private staging dir; nothing published yet.
    const staged = [];
    const scratch = mkdtempSync(join(tmpdir(), 'evals-internal-corpus-archive-'));
    try {
      const emptyAttributes = join(scratch, 'empty.gitattributes');
      writeFileSync(emptyAttributes, '', 'utf8');
      for (const p of plan) {
        mkdirSync(p.staging);
        staged.push(p.staging);
        const tarPath = join(scratch, `${p.r.repo}.tar`);
        git(p.checkout, ['-c', `core.attributesFile=${emptyAttributes}`, 'archive', '--format=tar', '-o', tarPath, p.r.commit_sha], {
          env: { ...process.env, GIT_ATTR_NOSYSTEM: '1' },
        });
        const untar = spawnSync('tar', ['-xf', tarPath, '-C', p.staging], { encoding: 'utf8' });
        unlinkSync(tarPath);
        // A `tar` that cannot be spawned (not on PATH — ENOENT) or exits non-zero is a TOOL
        // failure (exit 1), never a usage/IO error (exit 2) — Copilot on #475.
        if (untar.error !== undefined) {
          throw new ToolError(`tar could not be executed for ${p.name} (${untar.error.code ?? 'spawn error'}): ${untar.error.message} — materialize needs a working \`tar\` on PATH`);
        }
        if (untar.status !== 0) {
          throw new ToolError(`tar -xf failed for ${p.name} (${untar.status === null ? `signal ${untar.signal}` : `exit ${untar.status}`}): ${(untar.stderr ?? '').trim() || '(no output)'}`);
        }
        p.tree = verifyExtractedTree(p.checkout, p.r.commit_sha, p.staging, p.name);
      }
    } catch (err) {
      // The failure never reached the destinations: drop the staging, keep the previous trees and
      // their receipt as they were — unless the receipt describes a tree that is not there.
      for (const s of staged) rmSync(s, { recursive: true, force: true });
      dropReceiptWithoutTrees(receiptPath);
      throw err;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // Phase 2 — every tree verified. FIRST the receipt is invalidated: the in-progress marker is
    // published (it names the generation, so a torn swap is recognisable on the next start) and
    // the previous receipt is moved aside — from here until the new receipt lands there is NO
    // receipt at `materialized.json`, so a process killed between any two renames leaves
    // incomplete trees beside no receipt, never beside a stale success receipt. Then each tree is
    // swapped into place, keeping EVERY previous tree as `.prev-<generation>`; then the receipt
    // that describes exactly these trees is published; only then go the backups, the previous
    // receipt and (last) the marker. Any failure in here rolls the swap back and restores the
    // previous receipt — a COMPLETE rollback is the only way it comes back; if the rollback itself
    // fails, no receipt may describe what is left and the marker stays for the next repair.
    const receipt = { pin_hash: pin.pin_hash, generation, materialized_at: new Date().toISOString(), attributes: ARCHIVE_ATTRIBUTES_NOTE, repos: [] };
    /** Per repo, how far its swap got — what `rollbackSwap` undoes:
     *  `{ hadPrev, step }` with step 0 = nothing moved · 1 = dest moved to .prev · 2 = staging moved to dest. */
    const progress = new Map();
    const hadReceipt = existsSync(receiptPath);
    try {
      publishJson(marker, { generation, pid: process.pid, started_at: receipt.materialized_at, previous_receipt: hadReceipt ? receiptPrev : null, repos: plan.map((p) => p.name) }, generation);
      if (hadReceipt) renameSync(receiptPath, receiptPrev);
      for (const [i, p] of plan.entries()) {
        const state = { hadPrev: existsSync(p.dest), step: 0 };
        progress.set(p, state);
        if (state.hadPrev) renameSync(p.dest, p.prev);
        state.step = 1;
        injectedFault(`swap:${i + 1}`);
        injectedKill(`kill-between-swaps:${i + 1}`);
        renameSync(p.staging, p.dest);
        state.step = 2;
        receipt.repos.push({ repo: p.r.repo, tag: p.r.tag, commit_sha: p.r.commit_sha, tree_sha: p.tree.tree_sha, entries: p.tree.entries, path: p.dest });
      }
      injectedFault('receipt');
      publishJson(receiptPath, receipt, generation);
      injectedKill('kill-after-receipt');
    } catch (err) {
      const why = (e) => (e instanceof Error ? e.message : String(e));
      try {
        injectedFault('rollback');
        rollbackSwap(plan, progress);
        // A receipt write that tore between its tmp write and its rename left the tmp beside it.
        rmSync(`${receiptPath}.${generation}.tmp`, { force: true });
        // The destinations are the previous trees again, byte for byte — so the previous receipt
        // describes them again: it comes back ONLY here, after a complete rollback (unless it
        // describes a tree that was never there).
        if (existsSync(receiptPrev)) renameSync(receiptPrev, receiptPath);
        rmSync(marker, { force: true });
        dropReceiptWithoutTrees(receiptPath);
      } catch (rollbackErr) {
        rmSync(receiptPath, { force: true });
        rmSync(receiptPrev, { force: true });
        throw new RefusalError(
          `materialize failed while swapping the verified trees into ${root} (${why(err)}) AND the rollback failed (${why(rollbackErr)}) — ` +
            `the trees there may be damaged: every receipt was removed so nothing describes them, and the ${basename(marker)} marker stays so the next \`materialize\` repairs the root ` +
            `(rolls the .prev-${generation} trees back, removes the staging, re-extracts); inspect the .staging-${generation} / .prev-${generation} entries by hand first if you need the partial state`,
        );
      }
      throw err;
    }
    // Published: the receipt describes the trees now in place — the backups and the previous
    // receipt may go; the marker goes LAST (a kill in here is a torn CLEANUP: the receipt is valid
    // and the next start finishes the cleanup).
    for (const p of plan) rmSync(p.prev, { recursive: true, force: true });
    rmSync(receiptPrev, { force: true });
    rmSync(marker, { force: true });
    return receipt;
  });
}

/** `s` as a literal inside a RegExp source. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GENERATION_GROUP = `(${GENERATION_RE.source.slice(1, -1)})`;
const MARKER_RE = new RegExp(`^${escapeRe(MATERIALIZE_INPROGRESS_PREFIX)}${GENERATION_GROUP}$`);
const PREV_RECEIPT_RE = new RegExp(`^${escapeRe(MATERIALIZE_RECEIPT)}\\.prev-${GENERATION_GROUP}$`);
const PREV_TREE_RE = new RegExp(`^\\.(.+)\\.prev-${GENERATION_GROUP}$`);
const STAGING_TREE_RE = new RegExp(`^\\.(.+)\\.staging-${GENERATION_GROUP}$`);

/**
 * What a materialize root holds BEYOND its trees and receipt, classified — what a reader must
 * know before trusting `materialized.json`, and what `materialize` repairs before it starts:
 *   clean          nothing of ours but the trees and (maybe) the receipt
 *   torn-cleanup   a receipt of generation g beside ONLY g's marker / `.prev-g` entries: g's swap
 *                  completed and its receipt landed, the cleanup after it did not finish — the
 *                  receipt is valid, the leftovers are removable
 *   stale-staging  `.staging-*` dirs and nothing else of ours: an extraction was interrupted
 *                  before any tree moved — trees and receipt are untouched, the staging is debris
 *   damaged        an in-progress marker, a `.prev-*` tree or a moved-aside receipt the receipt
 *                  does not account for: a swap was interrupted (a kill between two renames) — NO
 *                  receipt at `materialized.json` may be trusted (the swap moved it aside before
 *                  the first tree moved; one there anyway is not this root's), and
 *                  `materialize <dir>` is the repair
 * Every entry is a direct child of the root's realpath; a symlink among them is refused
 * (`containedChild`). `receipt` is the parsed `materialized.json`, or null when absent/unreadable.
 */
export function inspectMaterializeRoot(outDir) {
  if (!existsSync(outDir)) throw new UsageError(`no materialize root at ${outDir}`);
  const root = realpathSync(outDir);
  const receiptPath = join(root, MATERIALIZE_RECEIPT);
  let receipt = null;
  if (existsSync(receiptPath)) {
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      receipt = null;
    }
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) receipt = null;
  }
  const markers = [];
  const prevTrees = [];
  const prevReceipts = [];
  const staging = [];
  for (const name of readdirSync(root).sort()) {
    let m;
    if ((m = MARKER_RE.exec(name)) !== null) markers.push({ name, path: containedChild(root, name), generation: m[1] });
    else if ((m = PREV_RECEIPT_RE.exec(name)) !== null) prevReceipts.push({ name, path: containedChild(root, name), generation: m[1] });
    else if ((m = PREV_TREE_RE.exec(name)) !== null) prevTrees.push({ name, path: containedChild(root, name), tree: m[1], generation: m[2] });
    else if ((m = STAGING_TREE_RE.exec(name)) !== null) staging.push({ name, path: containedChild(root, name), tree: m[1], generation: m[2] });
  }
  const debris = [...markers, ...prevTrees, ...prevReceipts];
  const generations = [...new Set([...debris, ...staging].map((d) => d.generation))].sort();
  let state = 'clean';
  const reasons = [];
  if (debris.length > 0) {
    const receiptGen = typeof receipt?.generation === 'string' ? receipt.generation : null;
    const accounted = receiptGen !== null && debris.every((d) => d.generation === receiptGen) && staging.every((s) => s.generation !== receiptGen);
    state = accounted ? 'torn-cleanup' : 'damaged';
    for (const mk of markers) {
      let started = null;
      try {
        started = JSON.parse(readFileSync(mk.path, 'utf8'));
      } catch {
        started = null;
      }
      reasons.push(`in-progress marker ${mk.name}${Number.isInteger(started?.pid) ? ` (pid ${started.pid})` : ''}`);
    }
    for (const t of prevTrees) reasons.push(existsSync(join(root, t.tree)) ? `${t.name} beside a swapped-in ${t.tree}` : `${t.name} with ${t.tree} MISSING`);
    for (const r of prevReceipts) reasons.push(`the previous receipt ${r.name} moved aside`);
    if (staging.length > 0) reasons.push(`${staging.length} staging dir(s)`);
  } else if (staging.length > 0) {
    state = 'stale-staging';
    reasons.push(`${staging.length} staging dir(s) an interrupted extraction left`);
  }
  return { root, state, receipt, reasons, generations, markers, prevTrees, prevReceipts, staging };
}

/**
 * Put a materialize root into a known state before a materialization starts (under the lock),
 * from `inspectMaterializeRoot`'s reading. Returns the `repaired …` lines for the operator.
 *   damaged        whatever sits at `materialized.json` is removed (untrusted); every `.prev-*` tree
 *                  is rolled back — a swapped-in tree at its destination is replaced by the backup,
 *                  a missing destination is filled from it (rename: byte-identical to before the
 *                  torn swap); staging dirs, moved-aside receipts and markers are removed. The old
 *                  receipt is NOT restored: a crash-rolled-back root is unverified until the next
 *                  successful publication describes it.
 *   torn-cleanup   the backups, the moved-aside receipt and the marker of the published generation
 *                  are removed — the receipt already describes the trees in place.
 *   stale-staging  the staging dirs are removed; trees and receipt were never touched.
 */
function repairMaterializeRoot(root, inspection) {
  const lines = [];
  const rmAll = (entries, opts) => {
    for (const e of entries) rmSync(e.path, { force: true, ...opts });
  };
  if (inspection.state === 'damaged') {
    rmSync(join(root, MATERIALIZE_RECEIPT), { force: true });
    let restored = 0;
    let replaced = 0;
    for (const t of inspection.prevTrees) {
      const dest = containedChild(root, t.tree);
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
        replaced += 1;
      }
      renameSync(t.path, dest);
      restored += 1;
    }
    rmAll(inspection.staging, { recursive: true });
    rmAll(inspection.prevReceipts);
    rmAll(inspection.markers);
    lines.push(
      `repaired  ${root}: a materialization (generation ${inspection.generations.join(', ')}) was interrupted during its swap — ${inspection.reasons.join('; ')}; ` +
        `restored ${restored} previous tree(s) from their .prev backups (${replaced} swapped-in tree(s) replaced), removed ${inspection.staging.length} staging dir(s), ` +
        `the previous receipt and the marker; no receipt describes this root until this run publishes one`,
    );
  } else if (inspection.state === 'torn-cleanup') {
    rmAll(inspection.prevTrees, { recursive: true });
    rmAll(inspection.staging, { recursive: true });
    rmAll(inspection.prevReceipts);
    rmAll(inspection.markers);
    lines.push(`repaired  ${root}: finished the interrupted cleanup of generation ${inspection.generations.join(', ')} (${inspection.prevTrees.length} backup(s), the previous receipt and the marker removed; the receipt was already valid)`);
  } else if (inspection.state === 'stale-staging') {
    rmAll(inspection.staging, { recursive: true });
    lines.push(`repaired  ${root}: removed ${inspection.staging.length} staging dir(s) an interrupted extraction left (trees and receipt untouched)`);
  }
  return lines;
}

/**
 * The materialize receipt a CONSUMER may trust as the materialization OF `pin`, or a named refusal.
 * A damaged root (a swap was interrupted — `inspectMaterializeRoot`) is refused with the repair as
 * the hint; a missing or unreadable receipt is a usage error; and the receipt itself must pass, in
 * this order (codex round 6: the reader used to take ANY `repos[].path` that `existsSync` accepted
 * — a foreign directory, a symlink, a plain file — and a receipt without its pin/generation
 * identity, as a clean materialization):
 *   identity     `pin_hash` is the selected pin's; `generation` is a well-formed publication stamp;
 *   membership   `repos[]` names exactly the pin's repos — same `repo`, `tag`, `commit_sha`, each
 *                once — nothing extra, nothing missing;
 *   containment  every `repos[].path` IS `<root>/<repo>@<tag>` under the root's REALPATH: it is
 *                there, is not a symlink (`lstat`), is a directory, and its realpath is that very
 *                entry — a path outside the root, a link pointing anywhere, or a file is refused
 *                by name (never "clean").
 * Returns `{ receipt, root, debris }` — `debris` is the inspection state (`clean`, or the harmless
 * `torn-cleanup` / `stale-staging` the next `materialize` sweeps).
 */
export function readMaterializeReceipt(outDir, pin) {
  if (pin === null || typeof pin !== 'object' || typeof pin.pin_hash !== 'string' || !Array.isArray(pin.repos)) {
    throw new UsageError('readMaterializeReceipt needs the selected pin ({ pin_hash, repos }) — a receipt is only ever trusted as the materialization OF a pin');
  }
  const inspection = inspectMaterializeRoot(outDir);
  if (inspection.state === 'damaged') {
    throw new RefusalError(
      `${inspection.root} is DAMAGED — ${inspection.reasons.join('; ')} — no receipt describes these trees; run \`materialize ${outDir}\` to repair ` +
        `(it rolls the .prev-<generation> trees back, removes the staging and the marker, re-extracts every pinned tree and publishes a new receipt), or inspect those entries by hand first`,
    );
  }
  const receiptPath = join(inspection.root, MATERIALIZE_RECEIPT);
  if (inspection.receipt === null) throw new UsageError(`${receiptPath} is missing or unreadable — run \`materialize ${outDir}\` first`);
  const receipt = inspection.receipt;
  const refuse = (what) => new RefusalError(`${receiptPath} ${what} — run \`materialize ${outDir}\` again`);
  // Identity: THIS pin's materialization, from a publication that can be named.
  if (typeof receipt.pin_hash !== 'string') throw refuse('carries no pin_hash — it is not the materialization of a pin');
  if (receipt.pin_hash !== pin.pin_hash) throw refuse(`was materialized from pin ${receipt.pin_hash} but the selected pin is ${pin.pin_hash}`);
  if (typeof receipt.generation !== 'string' || !GENERATION_RE.test(receipt.generation)) {
    throw refuse(`carries no well-formed generation stamp (got ${JSON.stringify(receipt.generation)})`);
  }
  // Membership: exactly the pin's repos, each described once at the pinned tag and sha.
  if (!Array.isArray(receipt.repos)) throw refuse('describes no repos array');
  const pinned = new Map(pin.repos.map((r) => [r.repo, r]));
  const seen = new Set();
  for (const [i, entry] of receipt.repos.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.repo !== 'string') throw refuse(`repos[${i}] names no repo`);
    const want = pinned.get(entry.repo);
    if (want === undefined) throw refuse(`describes ${JSON.stringify(entry.repo)}, which the selected pin does not have`);
    if (seen.has(entry.repo)) throw refuse(`describes ${entry.repo} twice`);
    seen.add(entry.repo);
    if (entry.tag !== want.tag || entry.commit_sha !== want.commit_sha) {
      throw refuse(`describes ${entry.repo} at ${JSON.stringify(entry.tag)} ${JSON.stringify(entry.commit_sha)} but the pin has ${want.tag} ${want.commit_sha}`);
    }
  }
  const missing = [...pinned.keys()].filter((r) => !seen.has(r)).sort();
  if (missing.length > 0) throw refuse(`does not describe ${missing.length} pinned repo(s) (${listSome(missing)})`);
  // Containment: each described tree is the real directory <root>/<repo>@<tag> — nothing else.
  for (const entry of receipt.repos) {
    const name = `${entry.repo}@${entry.tag}`;
    const expected = join(inspection.root, name);
    if (typeof entry.path !== 'string') throw refuse(`describes ${name} with no path`);
    let st;
    try {
      st = lstatSync(entry.path);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw refuse(`describes ${name} at ${entry.path}, which is not there`);
      throw err;
    }
    if (st.isSymbolicLink()) throw refuse(`describes ${name} at ${entry.path}, which is a symlink — a tree reached through a link is not the materialized tree`);
    if (!st.isDirectory()) throw refuse(`describes ${name} at ${entry.path}, which is not a directory`);
    const real = realpathSync(entry.path);
    if (real !== expected) {
      const outside = !real.startsWith(`${inspection.root}${sep}`);
      throw refuse(`describes ${name} at ${entry.path}${real === entry.path ? '' : ` (→ ${real})`}, which is not ${expected}${outside ? ' — outside the materialize root' : ''}`);
    }
  }
  return { receipt, root: inspection.root, debris: inspection.state };
}

/**
 * Undo a partial swap (materialize Phase 2), newest repo first, from what `progress` recorded per
 * repo: a swapped-in tree (step 2) is removed and its `.prev` restored to the destination; a
 * destination moved to `.prev` whose staging never landed (step 1) is restored and the staging
 * removed; a repo the swap never reached loses only its staging. A repo without a previous tree
 * (`hadPrev` false — a first run) ends with no destination at all. Throws on the first fs failure —
 * the caller then removes the receipt and names both faults.
 */
function rollbackSwap(plan, progress) {
  for (const p of [...plan].reverse()) {
    const state = progress.get(p) ?? { hadPrev: false, step: 0 };
    if (state.step === 2) rmSync(p.dest, { recursive: true, force: true });
    else rmSync(p.staging, { recursive: true, force: true });
    if (state.step >= 1 && state.hadPrev) renameSync(p.prev, p.dest);
  }
}

/**
 * After a FAILED materialization: the receipt may stay only while every tree it describes is still
 * there (a failed repeat over intact previous trees). A receipt beside a missing tree — a failed
 * first run that somehow found one, or trees an operator removed by hand — describes output that
 * does not exist and is removed; an unreadable receipt is removed too.
 */
function dropReceiptWithoutTrees(receiptPath) {
  if (!existsSync(receiptPath)) return;
  let described = null;
  try {
    described = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    described = null;
  }
  const paths = Array.isArray(described?.repos) ? described.repos.map((x) => x?.path) : null;
  if (paths === null || paths.some((p) => typeof p !== 'string' || !existsSync(p))) rmSync(receiptPath, { force: true });
}

/** git's blob object id of `bytes` — `sha1("blob <len>\0" + bytes)`; what `ls-tree` prints. */
function blobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** `ls-tree -r -z <commit>`: `path → { mode, oid }` for every blob/symlink; gitlinks counted, not
 *  listed (`git archive` writes nothing for a submodule). Paths verbatim — the first TAB ends the
 *  metadata, everything after it is the name, tabs and newlines included. */
function committedTree(checkout, commitSha) {
  const entries = new Map();
  let gitlinks = 0;
  for (const entry of gitRaw(checkout, ['ls-tree', '-r', '-z', commitSha]).split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) throw new Error(`unparseable ls-tree -z entry in ${checkout}: ${JSON.stringify(entry.slice(0, 80))}`);
    const [mode, , oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (mode === '160000') {
      gitlinks += 1;
      continue;
    }
    entries.set(path, { mode, oid });
  }
  return { entries, gitlinks };
}

/** Every regular file and symlink under `root`, as `relative/posix/path → blob oid`. */
function extractedTree(root) {
  const found = new Map();
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      const rel = relative(root, full).split(sep).join('/');
      if (d.isDirectory()) walk(full);
      else if (d.isSymbolicLink()) found.set(rel, blobOid(Buffer.from(readlinkSync(full))));
      else if (d.isFile()) found.set(rel, blobOid(readFileSync(full)));
      else throw new RefusalError(`refusing to accept ${full}: neither a file, a directory nor a symlink`);
    }
  };
  walk(root);
  return found;
}

/**
 * The extracted `dest` must be the committed tree of `commitSha`, entry for entry: every
 * `ls-tree` path present with the same blob id, nothing missing, nothing substituted
 * (`export-subst`), nothing extra. Refuses (exit 1) naming the paths and the attribute sources
 * git honors that this script cannot override. Returns the tree id + entry count for the receipt.
 */
function verifyExtractedTree(checkout, commitSha, dest, label) {
  const tree_sha = git(checkout, ['rev-parse', `${commitSha}^{tree}`]);
  const { entries, gitlinks } = committedTree(checkout, commitSha);
  const actual = extractedTree(dest);
  // Some tar implementations extract git's pax global header (the commit id) as a top-level
  // file of that name; it is not part of any tree — remove it before judging extras.
  if (actual.has('pax_global_header') && !entries.has('pax_global_header')) {
    unlinkSync(join(dest, 'pax_global_header'));
    actual.delete('pax_global_header');
  }
  const missing = [...entries.keys()].filter((p) => !actual.has(p)).sort();
  const extra = [...actual.keys()].filter((p) => !entries.has(p)).sort();
  const differing = [...entries].filter(([p, e]) => actual.has(p) && actual.get(p) !== e.oid).map(([p]) => p).sort();
  if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
    throw new RefusalError(
      `refusing to accept the materialized ${label}: the extracted tree is not the committed tree ${tree_sha}` +
        (missing.length > 0 ? `\n  missing (${missing.length}): ${listSome(missing)}` : '') +
        (differing.length > 0 ? `\n  content differs (${differing.length}): ${listSome(differing)}` : '') +
        (extra.length > 0 ? `\n  extra (${extra.length}): ${listSome(extra)}` : '') +
        `\n  the operator's global/system attributes were pinned away for the archive; an export-ignore/export-subst in ` +
        `${checkout}/.git/info/attributes or in the commit's own .gitattributes cannot be overridden — remove it, or pin a commit without it`,
    );
  }
  return { tree_sha, entries: entries.size, gitlinks };
}

/** Classify ONE touched path by the explicit table (first matching row wins), or null. */
export function classifyPath(path) {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  for (const row of PATH_TYPE_TABLE) {
    if (row.segments?.some((s) => dirs.includes(s))) return row.type;
    if (row.files?.includes(file)) return row.type;
    if (row.suffixes?.some((s) => file.endsWith(s))) return row.type;
  }
  return null;
}

/** The sample's steering type: the type of a STRICT MAJORITY of touched files, else development. */
export function inferSteeringType(files) {
  if (files.length === 0) return DEFAULT_STEERING_TYPE;
  const counts = new Map();
  for (const f of files) {
    const t = classifyPath(f);
    if (t !== null) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  for (const [type, n] of counts) {
    if (n * 2 > files.length) return type;
  }
  return DEFAULT_STEERING_TYPE;
}

/**
 * The window's commits, newest first, from ONE `git log -z` (record separator \x1e, field
 * separator \x1f, then the touched paths NUL-delimited). `--diff-merges=first-parent` gives a
 * merge commit the files it landed on the mainline. The extraction's git configuration is EXPLICIT
 * and complete (`GIT_LOG_CONFIG` + the command-line twins): a rename is a delete + an add (both
 * paths touched, no similarity heuristic), paths come in tree order and VERBATIM (`-z` is git's
 * "do not munge pathnames": no C-quoting of tabs, quotes, backslashes or newlines, which
 * `core.quotePath=false` alone leaves in place), messages in UTF-8, no signature lines — the same
 * bytes under any operator's global/system/repo git config. Paths are never trimmed.
 */
export function windowCommits(checkout, fromSha, tagSha) {
  const raw = gitRaw(checkout, [
    '--no-pager',
    ...GIT_LOG_CONFIG.flatMap((kv) => ['-c', kv]),
    'log',
    '-z',
    '--format=%x1e%H%x1f%s%x1f%b%x1f',
    '--name-only',
    '--no-renames',
    '--no-ext-diff',
    '--no-show-signature',
    '--ignore-submodules=none',
    '-O/dev/null',
    '--diff-merges=first-parent',
    `${fromSha}..${tagSha}`,
  ]);
  const commits = [];
  for (const record of raw.split('\x1e')) {
    if (record === '') continue;
    const fields = record.split('\x1f');
    if (fields.length !== 4) {
      throw new Error(`unparseable git log record in ${checkout} (a commit message carries a field separator?): ${record.slice(0, 80)}`);
    }
    const [sha, subject, body, tail] = fields;
    commits.push({ sha, subject: subject.trim(), body: body.trim(), files: parseNulPaths(tail, checkout, sha) });
  }
  return commits;
}

/**
 * The `--name-only -z` tail of ONE record. git terminates the format with a NUL; when the commit
 * touched files, exactly one `\n` follows and then each path NUL-TERMINATED, verbatim. So the
 * grammar is `\0` | `\0\n(<path>\0)+`. Asserted, never assumed — any other shape is a parse error
 * naming the commit — and a path is NEVER trimmed: leading/trailing spaces, tabs, quotes,
 * backslashes and newlines are the real name (a path cannot be empty or contain NUL, so the split
 * is exact).
 */
export function parseNulPaths(tail, checkout, sha) {
  const bad = (why) => new Error(`unparseable --name-only -z tail for ${sha} in ${checkout}: ${why} (${JSON.stringify(tail.slice(0, 40))})`);
  if (!tail.startsWith('\0')) throw bad('expected a NUL after the header');
  const rest = tail.slice(1);
  if (rest === '') return [];
  if (!rest.startsWith('\n')) throw bad('expected a newline before the path list');
  if (!rest.endsWith('\0')) throw bad('expected the last path to be NUL-terminated');
  const files = rest.slice(1, -1).split('\0');
  if (files.some((f) => f === '')) throw bad('an empty path');
  return files;
}

/**
 * Read the known-bad allowlist file `{ samples: { "<repo>@<sha12>": { reason, steering_type? } } }`
 * and RETURN its validated `samples` map alone — `id → { reason, steering_type? }` (the object the
 * derivation indexes by sample id; the file's other keys, e.g. `description`, are for humans and
 * are not returned). FAIL-CLOSED: a missing, unreadable or malformed file, or a `samples` that is
 * not the keyed map, is a usage error — never an empty allowlist. (A misspelled `--known-bad` path
 * would otherwise silently relabel every bad commit `good`.) The empty allowlist is spelled
 * `{"samples": {}}` and returns `{}`.
 */
export function readKnownBad(path) {
  if (!existsSync(path)) {
    throw new UsageError(`no known-bad file at ${path} (pass --known-bad <file>; an EMPTY allowlist is {"samples": {}} — a missing file is not one)`);
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`could not read known-bad file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${path}: the known-bad file must be an object with a "samples" map`);
  }
  const entries = parsed.samples;
  if (entries === null || entries === undefined || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new UsageError(`${path}: "samples" must be an object keyed by sample id (<repo>@<sha12>) — got ${entries === undefined ? 'no samples key' : Array.isArray(entries) ? 'an array' : JSON.stringify(entries)}`);
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      throw new UsageError(`${path}: known-bad ${id} needs a non-empty "reason"`);
    }
    if (entry.steering_type !== undefined && !STEERING_TYPES.includes(entry.steering_type)) {
      throw new UsageError(`${path}: known-bad ${id} steering_type ${JSON.stringify(entry.steering_type)} is not one of ${STEERING_TYPES.join('|')}`);
    }
  }
  return entries;
}

/**
 * The ROUTE's own validator — `EvalSampleSchema` from `packages/crew/src/api/eval-sample.js`, the
 * very module `POST /testing/corpora/import` parses with (strict object, closed `kind`, non-empty
 * strings, strict `signals` with string `phase`/`tool`, string[] `files`, string `content`) —
 * PLUS the engine's `EvalSample::validate` (a known steering type; the schema leaves
 * `steering_type` open on purpose, the engine owns that vocabulary). No hand mirror: whatever the
 * route rejects, this rejects, by construction. Returns the list of violations as
 * `<path>: <message>` (empty = valid).
 */
export function validateSample(sample) {
  const parsed = EvalSampleSchema.safeParse(sample);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.length === 0 ? '(sample)' : i.path.join('.')}: ${i.message}`);
  }
  if (!STEERING_TYPES.includes(parsed.data.steering_type)) {
    return [`steering_type: ${JSON.stringify(parsed.data.steering_type)} is not one of ${STEERING_TYPES.join('|')}`];
  }
  return [];
}

/**
 * `samples <dir>`: one EvalSample per window commit across the pinned repos — id
 * `<repo>@<sha12>`, `steering_type` from the path table, `files` = touched paths, `content` =
 * subject + body, `kind` good unless the known-bad allowlist names the id. Every sample is
 * validated; a known-bad id absent from the window is a stale allowlist entry and fails closed.
 * Each repo's derived window commit count AND sample count must equal the `commits` the pin
 * recorded (from `rev-list --count` at pin time) — a truncated or grafted history that still
 * resolves both tags, or a hand-edited count, is a DriftError naming both numbers; the total is
 * checked the same way. Never a smaller sample set published under the pin's identity.
 */
export function deriveSamples(pin, pinPath, sourceRoot, knownBad) {
  requirePinnedCheckouts(pin, pinPath, sourceRoot);
  const samples = [];
  const perRepo = [];
  const unusedKnownBad = new Set(Object.keys(knownBad));
  for (const r of [...pin.repos].sort(byRepo)) {
    const checkout = sourceCheckout(sourceRoot, r.repo);
    const commits = windowCommits(checkout, r.action_window_from_sha, r.commit_sha);
    if (commits.length !== r.commits) {
      throw new DriftError(
        `${r.repo}: the window ${r.action_window_from_tag}..${r.tag} derived ${commits.length} commit(s) but the pin records ${r.commits} — ` +
          'the checkout does not hold the pinned history (incomplete or grafted history, or a hand-edited count); refusing to publish a sample set that is not the pin\'s',
      );
    }
    const before = samples.length;
    for (const c of commits) {
      const id = `${r.repo}@${c.sha.slice(0, SHORT_SHA_LEN)}`;
      const bad = knownBad[id];
      unusedKnownBad.delete(id);
      const subject = c.subject === '' ? id : c.subject;
      const content = c.body === '' ? subject : `${subject}\n\n${c.body}`;
      const sample = {
        id,
        description: bad ? `${subject} — marked bad: ${bad.reason}` : subject,
        kind: bad ? 'bad' : 'good',
        steering_type: bad?.steering_type ?? inferSteeringType(c.files),
        signals: { files: c.files, content },
      };
      const problems = validateSample(sample);
      if (problems.length > 0) throw new Error(`sample ${id} is invalid: ${problems.join('; ')}`);
      samples.push(sample);
    }
    const derived = samples.length - before;
    if (derived !== r.commits) {
      throw new DriftError(`${r.repo}: derived ${derived} sample(s) for a window the pin records as ${r.commits} commits — one sample per window commit, no more, no fewer`);
    }
    perRepo.push({ repo: r.repo, from: r.action_window_from_tag, tag: r.tag, commits: commits.length });
  }
  if (unusedKnownBad.size > 0) {
    throw new DriftError(
      `known-bad names ${unusedKnownBad.size} id(s) not in any pinned window (stale entry or a moved tag): ${[...unusedKnownBad].sort().join(', ')}`,
    );
  }
  const expectedTotal = pin.repos.reduce((n, r) => n + r.commits, 0);
  if (samples.length !== expectedTotal) {
    throw new DriftError(`derived ${samples.length} samples but the pin's windows record ${expectedTotal} commits in total`);
  }
  const ids = new Set(samples.map((s) => s.id));
  if (ids.size !== samples.length) throw new Error('duplicate sample ids across the pinned windows');
  const typeCounts = {};
  for (const s of samples) typeCounts[s.steering_type] = (typeCounts[s.steering_type] ?? 0) + 1;
  const meta = {
    pin_hash: pin.pin_hash,
    samples_hash: samplesHash(samples),
    corpus_name: corpusName(pin.pin_hash),
    total: samples.length,
    bad: samples.filter((s) => s.kind === 'bad').length,
    steering_types: Object.fromEntries(Object.entries(typeCounts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    windows: perRepo,
  };
  return { samples, meta };
}

/** The corpus name a crew import / eval run should carry: pinned by content, not by a label. */
export function corpusName(pinHashValue) {
  return `evals:wicked-internal@${pinHashValue.replace(/^sha256:/, '').slice(0, 16)}`;
}

/**
 * Publish the derived samples ATOMICALLY: take `<dir>/.samples.lock` (exclusive create — a held
 * lock is a refusal, never an interleaving), write samples.json then samples.meta.json each via
 * tmp+rename, both stamped with ONE `generation` (the tmp names carry it; the meta records it), and
 * release the lock. samples.json stays the pure sample array (the engine's corpus format, byte-
 * deterministic for a given pin + allowlist); the meta is published LAST and names the samples it
 * describes by `samples_hash`, so a reader that verifies the hash (as `run` does) can never pair a
 * complete-looking meta with samples it does not describe. Returns the stamped meta.
 */
export function publishSamples(outDir, samples, meta) {
  return withPublicationLock(join(outDir, SAMPLES_LOCK), 'samples', (generation) => {
    const stamped = { ...meta, generation };
    publishJson(join(outDir, 'samples.json'), samples, generation);
    publishJson(join(outDir, 'samples.meta.json'), stamped, generation);
    return stamped;
  });
}

/**
 * The published pair, VERIFIED against the selected pin: both files present; samples.meta.json was
 * derived from THIS pin (`pin_hash`) and describes THESE samples (`samples_hash` recomputed over
 * samples.json, `total`); every sample valid and unique. A mismatch is a refusal that names the
 * two values — a torn or foreign publication is never evaluated as if it were the pinned corpus.
 */
export function readPublishedSamples(outDir, pin) {
  const samplesPath = join(outDir, 'samples.json');
  const metaPath = join(outDir, 'samples.meta.json');
  for (const p of [samplesPath, metaPath]) {
    if (!existsSync(p)) throw new UsageError(`${p} is missing — run \`samples ${outDir}\` first`);
  }
  const samples = JSON.parse(readFileSync(samplesPath, 'utf8'));
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!Array.isArray(samples)) throw new RefusalError(`${samplesPath} is not an array of samples`);
  if (meta === null || typeof meta !== 'object') throw new RefusalError(`${metaPath} is not a samples meta object`);
  if (meta.pin_hash !== pin.pin_hash) {
    throw new RefusalError(
      `pin_hash mismatch: ${metaPath} was derived from ${meta.pin_hash} but the selected pin is ${pin.pin_hash} — re-run \`samples ${outDir}\` against this pin`,
    );
  }
  const actual = samplesHash(samples);
  if (meta.samples_hash !== actual) {
    throw new RefusalError(
      `samples_hash mismatch: ${metaPath} describes ${meta.samples_hash} but ${samplesPath} hashes to ${actual} — a torn or foreign publication; re-run \`samples ${outDir}\``,
    );
  }
  if (meta.total !== samples.length) {
    throw new RefusalError(`total mismatch: ${metaPath} says ${meta.total} samples but ${samplesPath} holds ${samples.length}`);
  }
  const ids = new Set();
  for (const s of samples) {
    const problems = validateSample(s);
    if (problems.length > 0) throw new RefusalError(`${samplesPath}: sample ${JSON.stringify(s?.id)} is invalid: ${problems.join('; ')}`);
    if (ids.has(s.id)) throw new RefusalError(`${samplesPath}: duplicate sample id ${s.id}`);
    ids.add(s.id);
  }
  return { samples, meta };
}

/**
 * The candidate files `spawnSync(name)` would try, IN ORDER, with the OS's own search semantics —
 * so the executable this script hashes is the executable it spawns (both use the winner):
 *   - `name` with a separator is a path: one candidate, resolved against `cwd`;
 *   - otherwise every entry of `path` (`PATH`) in order, each resolved against `cwd` — an EMPTY
 *     entry (a leading, trailing or doubled delimiter) is the CURRENT DIRECTORY, exactly as
 *     execvp reads it (codex round 5: skipping it identified another build than the one the spawn
 *     ran); on Windows (libuv) the cwd is searched FIRST, and every candidate is tried bare and
 *     with each `PATHEXT` extension.
 * An unset `path` searches nothing: nothing is spawned by bare name any more, so libc's default
 * search path is not something a spawn could disagree with.
 */
export function executableCandidates(name, opts = {}) {
  // `Object.hasOwn`, not parameter defaults: an EXPLICIT `path: undefined` means "PATH is unset"
  // (a default would silently substitute the process's PATH for it).
  const path = Object.hasOwn(opts, 'path') ? opts.path : process.env['PATH'];
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const pathext = Object.hasOwn(opts, 'pathext') ? opts.pathext : process.env['PATHEXT'];
  const win = platform === 'win32';
  const exts = win ? ['', ...(pathext ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e !== '')] : [''];
  if (/[\\/]/.test(name)) return exts.map((ext) => resolve(cwd, `${name}${ext}`));
  const dirs = path === undefined ? [] : path.split(win ? ';' : ':');
  if (win) dirs.unshift('');
  return dirs.flatMap((dir) => exts.map((ext) => resolve(cwd, dir === '' ? '.' : dir, `${name}${ext}`)));
}

/**
 * The executable `spawnSync(name)` WOULD run, resolved ONCE over `executableCandidates`: the first
 * candidate that is an executable REGULAR file, as its REALPATH — `{ path }`. A candidate that is
 * NOT THERE (`ENOENT`; `ENOTDIR` — a PATH entry that is a file) is passed over exactly as exec
 * passes over it, and so is a directory. A regular file the process may not execute (`access`
 * `EACCES`) is passed over too but remembered: when NO candidate is executable, `{ path: null,
 * blocked }` names the first such file (what exec reports as EACCES — the caller spawns it and lets
 * the OS say so, never a SKIP). Nothing on the search path naming the executable is `{ path: null,
 * blocked: null, error: null }` — exec's ENOENT, the documented SKIP. ANY OTHER lookup failure —
 * `stat` refused (`EACCES` on a PATH directory the process may not search), an I/O fault (`EIO`),
 * a stale mount, a `realpath` that fails — is `{ path: null, error: { syscall, code, candidate,
 * message } }`: which file a spawn would run CANNOT BE DETERMINED, and that is a tool failure, never
 * "not installed" (codex round 6: every lookup error used to fall through to the exit-zero SKIP;
 * only true absence may). `searched` lists every candidate tried, in order.
 */
export function resolveExecutable(name, opts = {}) {
  const searched = executableCandidates(name, opts);
  const platform = opts.platform ?? process.platform;
  const absent = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
  const fault = (syscall, candidate, err) => ({
    path: null,
    blocked: null,
    error: { syscall, code: typeof err?.code === 'string' ? err.code : 'UNKNOWN', candidate, message: err instanceof Error ? err.message : String(err) },
    searched,
  });
  let blocked = null;
  for (const c of searched) {
    let st;
    try {
      injectedLookupFault('stat');
      st = statSync(c);
    } catch (err) {
      if (absent(err)) continue;
      return fault('stat', c, err);
    }
    if (!st.isFile()) continue;
    if (platform !== 'win32') {
      try {
        injectedLookupFault('access');
        accessSync(c, fsConstants.X_OK);
      } catch (err) {
        if (absent(err)) continue; // removed between stat and access — not there
        if (err?.code === 'EACCES') {
          if (blocked === null) blocked = c; // a regular file without execute permission: exec's EACCES
          continue;
        }
        return fault('access', c, err);
      }
    }
    try {
      return { path: realpathSync(c), blocked: null, error: null, searched };
    } catch (err) {
      return fault('realpath', c, err);
    }
  }
  return { path: null, blocked, error: null, searched };
}

/**
 * The content identity of a directory of rule sources: sha256 over the canonical JSON of
 * `[[relative/posix/path, sha256hex(bytes)], …]`, codepoint-sorted by path, every regular file
 * (symlinks read through). What `rules ingest <dir>` was handed, byte for byte.
 */
export function seedDirIdentity(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.push([relative(dir, full).split(sep).join('/'), sha256Hex(readFileSync(full))]);
    }
  };
  walk(dir);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { dir, sha256: `sha256:${sha256Hex(canonicalJsonLocal(files))}`, files: files.length };
}

/** Canonical JSON (keys codepoint-sorted at every depth, compact) — the same serialization
 *  `eval-sample.js` uses for the payload hash, restated for values that are not samples. */
function canonicalJsonLocal(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonLocal(v === undefined ? null : v)).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonLocal(v)}`)
    .join(',')}}`;
}

/**
 * The rule-snapshot identity over the rules an engine LISTED back from the store it evaluated:
 * sha256 over the canonical JSON of the FULL rules (every field, retired included — plan §3),
 * codepoint-sorted by `id` (ties by their canonical text). A rule without a string `id` is an
 * error — the identity cannot be anchored.
 */
export function rulesSnapshotHash(rules) {
  const keyed = rules.map((r, i) => {
    if (r === null || typeof r !== 'object' || typeof r.id !== 'string') {
      throw new Error(`rules list returned rules[${i}] without a string id: ${JSON.stringify(r).slice(0, 120)}`);
    }
    return [r.id, canonicalJsonLocal(r)];
  });
  keyed.sort(([ia, ta], [ib, tb]) => (ia < ib ? -1 : ia > ib ? 1 : ta < tb ? -1 : ta > tb ? 1 : 0));
  return `sha256:${sha256Hex(`[${keyed.map(([, t]) => t).join(',')}]`)}`;
}

/**
 * Classify the engine's answer to `rules list --db <tmp> --include-retired --json`:
 *   - a JSON envelope with a `rules` array ⇒ `{ method: 'engine-list', sha256, rule_count }`
 *   - the engine's usage banner (an engine that predates `rules list`) ⇒ `{ method: 'seed-dir',
 *     sha256: <the seed dir's>, reason }` — recorded, never silent
 *   - anything else ⇒ a tool failure (the command exists and did not answer)
 */
function rulesIdentityFrom(listed, coreBin, seed) {
  const out = listed.stdout ?? '';
  const err = listed.stderr ?? '';
  if (listed.error !== undefined) return { failure: `${coreBin} rules list could not be executed: ${listed.error.message}` };
  if (listed.status === 0) {
    let parsed = null;
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
      try {
        return {
          identity: {
            method: 'engine-list',
            command: 'rules list --db <tmp rules.db> --include-retired --json (read back before the temp db is deleted)',
            sha256: rulesSnapshotHash(parsed.rules),
            rule_count: parsed.rules.length,
          },
        };
      } catch (e) {
        return { failure: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  if (/^usage:/m.test(out) || /^usage:/m.test(err)) {
    return {
      identity: {
        method: 'seed-dir',
        sha256: seed.sha256,
        rule_count: null,
        reason: `this engine has no \`rules list\` command (it answered with its usage banner) — the identity is the canonical hash of the ingested seed directory's ${seed.files} file(s)`,
      },
    };
  }
  return { failure: `rules list failed (exit ${listed.status}): ${(err || out).trim().slice(0, 400) || '(no output)'}` };
}

/**
 * The engine's report, VERIFIED before anything is published — a report is an evaluation of the
 * full staged corpus or it is nothing:
 *   - a report object with a `results` array and a `summary` object;
 *   - EXACTLY one result per staged sample: every row names a staged `sample.id`, no id twice, no
 *     id that was not staged, no staged sample without a row (an empty report over six staged
 *     samples is the incomplete case, not a clean run);
 *   - every row carries a `verdict` from the engine's set (`ENGINE_VERDICTS`) and a `fired` array
 *     of rule ids, and echoes its staged sample's description/kind/steering_type;
 *   - every row is CONSISTENT with its sample's kind, as evals.rs `evaluate_sample` derives it:
 *     `expected` = `deny` for a bad sample, `allow` for a good one; a good sample is `caught` or
 *     `false_positive` — never `gap` (a gap is a BAD behavior nothing caught); a bad sample is
 *     `caught` or `gap` — never `false_positive` (a good behavior a rule denied); `fired` is
 *     non-empty exactly when a BLOCKING verdict fired (caught-on-bad, false_positive-on-good) —
 *     deny-dominates: the verdict and the fired set must agree;
 *   - the summary IS the rows' tally: `total` = rows, `caught`/`gaps`/`false_positives` = the
 *     verdict counts;
 *   - `degraded` is PRESENT (the engine always serializes it: null, or one of
 *     `ENGINE_DEGRADED_MODES`); `rule_coverage` is either ABSENT (an engine predating core #394,
 *     printed as such) or a well-formed `{ exercised: int ≥ 0, unexercised: [{ rule_id,
 *     steering_type }] }` — `null` (what crashed the summary print after publication) is malformed
 *     — with `recall_only` a non-negative integer when present and `per_type`, when present, a plain
 *     object keyed by steering type whose rows are `{ exercised, unexercised }` of non-negative
 *     integers (codex round 8: `per_type: null` passed through and crashed the offline comparison);
 *     that RECONCILES with the rows (`ruleCoverageProblem`): no id both fired and unexercised,
 *     `exercised` ≥ the distinct ids the rows' `fired` name, no duplicate unexercised id; and that
 *     does not CONTRADICT ITSELF: the per-type `exercised` sum to the total and each type's
 *     `unexercised` count equals the listed unexercised rows of that type (`run` evaluates
 *     UNFILTERED — its `rules eval` carries no `--type` — so the rows partition the whole eligible
 *     set; `development: { exercised: 999 }` beside `exercised: 0` is refused).
 * Each row then gets its staged sample's `payload_hash` (`eval-sample.js` `samplePayloadHash` over
 * the full payload incl. signals — what makes two runs comparable, `eval-compare.ts`). A valid
 * all-gap report — BAD samples nothing caught — passes: gaps are findings. Returns the failure text
 * (a named refusal), or null.
 */
export function verifyEngineReport(report, samples) {
  if (report === null || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.results)) {
    return 'rules eval printed a JSON value that is not a report object with a `results` array';
  }
  const staged = new Map(samples.map((s) => [s.id, s]));
  const seen = new Set();
  const counts = { caught: 0, gaps: 0, false_positives: 0 };
  /** rule id → the rows whose `fired` (blocking) named it — what `rule_coverage` must reconcile with. */
  const fired = new Map();
  for (const [i, row] of report.results.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return `results[${i}] is not a result object`;
    const ref = row.sample;
    if (ref === null || typeof ref !== 'object' || typeof ref.id !== 'string') return `results[${i}] carries no sample.id`;
    const s = staged.get(ref.id);
    if (s === undefined) {
      return `results[${i}] names sample ${JSON.stringify(ref.id)}, which was not staged — the engine evaluated something other than the pinned samples`;
    }
    if (seen.has(ref.id)) return `results[${i}] names sample ${ref.id} a second time — exactly one result per staged sample, never two`;
    seen.add(ref.id);
    for (const k of ['description', 'kind', 'steering_type']) {
      if (ref[k] !== s[k]) return `results[${i}] (${ref.id}) echoes ${k} ${JSON.stringify(ref[k])} but the staged sample has ${JSON.stringify(s[k])}`;
    }
    if (!ENGINE_VERDICTS.includes(row.verdict)) {
      return `results[${i}] (${ref.id}) carries verdict ${JSON.stringify(row.verdict)}, not one of ${ENGINE_VERDICTS.join('|')}`;
    }
    if (!Array.isArray(row.fired) || row.fired.some((f) => typeof f !== 'string')) {
      return `results[${i}] (${ref.id}) carries no \`fired\` array of rule ids (got ${JSON.stringify(row.fired)})`;
    }
    // Consistency with the sample's kind — what evals.rs `evaluate_sample` derives, restated.
    const expectedOfKind = s.kind === 'bad' ? 'deny' : 'allow';
    if (row.expected !== expectedOfKind) {
      return `results[${i}] (${ref.id}) carries expected ${JSON.stringify(row.expected)} but a ${s.kind} sample expects ${JSON.stringify(expectedOfKind)} (the engine derives \`expected\` from \`kind\`)`;
    }
    const impossible = s.kind === 'good' ? 'gap' : 'false_positive';
    if (row.verdict === impossible) {
      return (
        `results[${i}] (${ref.id}) is a ${s.kind} sample with verdict ${JSON.stringify(row.verdict)} — impossible: ` +
        (s.kind === 'good' ? 'a gap is a BAD behavior nothing caught (a good sample is caught or false_positive)' : 'a false positive is a GOOD behavior a rule denied (a bad sample is caught or gap)')
      );
    }
    const blocking = row.verdict === (s.kind === 'bad' ? 'caught' : 'false_positive');
    if (row.fired.length > 0 !== blocking) {
      return blocking
        ? `results[${i}] (${ref.id}) says a blocking rule fired (${s.kind} ⇒ ${row.verdict}) but \`fired\` is empty — deny-dominates: the verdict and the fired set must agree`
        : `results[${i}] (${ref.id}) says nothing blocking fired (${s.kind} ⇒ ${row.verdict}) but \`fired\` names ${JSON.stringify(row.fired)} — deny-dominates: the verdict and the fired set must agree`;
    }
    counts[SUMMARY_FIELD_OF_VERDICT[row.verdict]] += 1;
    for (const id of new Set(row.fired)) fired.set(id, (fired.get(id) ?? 0) + 1);
    ref.payload_hash = samplePayloadHash(s);
  }
  if (seen.size !== staged.size) {
    const missing = [...staged.keys()].filter((id) => !seen.has(id)).sort();
    return (
      `the engine report is incomplete: ${report.results.length} result row(s) for ${staged.size} staged sample(s) — ` +
      `${missing.length} staged sample(s) have no result (${listSome(missing)}); every staged sample must be judged exactly once`
    );
  }
  const summary = report.summary;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return 'the engine report carries no `summary` object';
  const expected = { total: report.results.length, ...counts };
  const off = Object.entries(expected).filter(([k, v]) => summary[k] !== v);
  if (off.length > 0) {
    return (
      `the engine report's summary does not reconcile with its rows: ${off.map(([k, v]) => `${k} ${JSON.stringify(summary[k])} != ${v}`).join(', ')} ` +
      `(the rows tally total ${expected.total} · caught ${expected.caught} · gaps ${expected.gaps} · false_positives ${expected.false_positives})`
    );
  }
  // The wire shape's report-level fields: `degraded` is ALWAYS serialized by the engine (an absent
  // key is not "not degraded" — it is not the engine's report); `rule_coverage` is optional but,
  // when present, must be the object — `null` crashed the summary print AFTER publication.
  if (!('degraded' in report)) {
    return 'the engine report carries no `degraded` field (the wire shape always serializes it: null for full fidelity, "facet-only" when gap hints fell back to keyword matching)';
  }
  if (report.degraded !== null && !ENGINE_DEGRADED_MODES.includes(report.degraded)) {
    return `the engine report's \`degraded\` is ${JSON.stringify(report.degraded)}, not null or one of ${ENGINE_DEGRADED_MODES.join('|')}`;
  }
  if (report.rule_coverage !== undefined) {
    const problem = ruleCoverageProblem(report.rule_coverage, fired);
    if (problem?.malformed !== undefined) {
      return `the engine report's \`rule_coverage\` is malformed: ${problem.malformed} — an engine predating core #394 omits the field (recorded as such); a present field must be a well-formed { exercised, unexercised[] }, never null`;
    }
    if (problem?.inconsistent !== undefined) {
      return (
        `the engine report's \`rule_coverage\` does not reconcile with its rows: ${problem.inconsistent} — ` +
        'evals.rs `rule_coverage` partitions the eligible rules by whether ANY evaluated claim fired them, and a row\'s `fired` is the blocking subset of that'
      );
    }
    if (problem?.contradictory !== undefined) {
      return (
        `the engine report's \`rule_coverage\` contradicts itself: ${problem.contradictory} — ` +
        'evals.rs `rule_coverage` partitions the same eligible rules per steering type (`per_type`), so the rows\' `exercised` sum to the total and each type\'s `unexercised` is the number of listed unexercised rules of that type (`run` evaluates unfiltered)'
      );
    }
  }
  return null;
}

/**
 * Why `rc` is not a `rule_coverage` of THESE rows, or null when it is. Three kinds, kept apart:
 *   `{ malformed }`     — not the wire shape (api-types `GovernanceEvalRuleCoverage`): `exercised` a
 *                         non-negative integer, `unexercised` an array of `{ rule_id, steering_type }`
 *                         with a known steering type, `recall_only` (the engine's third field —
 *                         optional on the api-types shape since 0.27.0, so optional here) a
 *                         non-negative integer when present; `per_type` (the fourth, optional
 *                         likewise) a plain object whose keys are steering types and whose values are
 *                         `{ exercised, unexercised }` of non-negative integers — codex round 8:
 *                         `per_type: null` used to pass through and crash the offline comparison;
 *   `{ inconsistent }`  — the shape is fine but the numbers contradict the rows. The engine's
 *                         definition (wicked-governance `evals.rs`, `rule_coverage` + `run_evals`): a
 *                         rule is EXERCISED when ANY evaluated claim fired it — blocking or not (a
 *                         `warn`-effect firing counts) — and UNEXERCISED otherwise; a row's `fired`
 *                         is the BLOCKING (deny) subset of the same firings. Hence, exactly: no id in
 *                         any row's `fired` may be `unexercised`; `exercised` ≥ the number of distinct
 *                         ids the rows' `fired` name (equal only when nothing non-blocking fired);
 *                         `unexercised` names a rule at most once. `fired` is `rule id → rows`;
 *   `{ contradictory }` — the shape is fine but `per_type` contradicts the totals. `rule_coverage()`
 *                         buckets every eligible rule into its type's row as it counts it, so the
 *                         rows' `exercised` sum to `exercised` and each type's `unexercised` equals
 *                         the listed unexercised rules of that type — exactly, because `run` never
 *                         passes `--type` (the `rules eval` spawn carries no filter): the report is
 *                         unfiltered and the rows partition the WHOLE eligible set. A type listed in
 *                         `unexercised` with no `per_type` row is a contradiction too.
 */
function ruleCoverageProblem(rc, fired) {
  const malformed = (m) => ({ malformed: m });
  const inconsistent = (m) => ({ inconsistent: m });
  const contradictory = (m) => ({ contradictory: m });
  if (rc === null || typeof rc !== 'object' || Array.isArray(rc)) return malformed(`expected an object { exercised, unexercised[] }, got ${JSON.stringify(rc)}`);
  if (!Number.isInteger(rc.exercised) || rc.exercised < 0) return malformed(`exercised ${JSON.stringify(rc.exercised)} is not a non-negative integer`);
  if (!Array.isArray(rc.unexercised)) return malformed(`unexercised ${JSON.stringify(rc.unexercised)} is not an array`);
  if (rc.recall_only !== undefined && (!Number.isInteger(rc.recall_only) || rc.recall_only < 0)) {
    return malformed(`recall_only ${JSON.stringify(rc.recall_only)} is not a non-negative integer`);
  }
  const perType = rc.per_type;
  if (perType !== undefined) {
    if (perType === null || typeof perType !== 'object' || Array.isArray(perType)) return malformed(`per_type ${JSON.stringify(perType)} is not an object keyed by steering type`);
    for (const [t, row] of Object.entries(perType)) {
      if (!STEERING_TYPES.includes(t)) return malformed(`per_type key ${JSON.stringify(t)} is not one of ${STEERING_TYPES.join('|')}`);
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return malformed(`per_type.${t} ${JSON.stringify(row)} is not an object { exercised, unexercised }`);
      for (const k of ['exercised', 'unexercised']) {
        if (!Number.isInteger(row[k]) || row[k] < 0) return malformed(`per_type.${t}.${k} ${JSON.stringify(row[k])} is not a non-negative integer`);
      }
    }
  }
  const seen = new Set();
  /** steering type → how many `unexercised` rows list it — what `per_type[<type>].unexercised` must equal. */
  const listedByType = new Map();
  for (const [i, u] of rc.unexercised.entries()) {
    if (u === null || typeof u !== 'object' || Array.isArray(u) || typeof u.rule_id !== 'string' || u.rule_id === '') {
      return malformed(`unexercised[${i}] carries no string rule_id (got ${JSON.stringify(u)})`);
    }
    if (!STEERING_TYPES.includes(u.steering_type)) {
      return malformed(`unexercised[${i}] (${u.rule_id}) steering_type ${JSON.stringify(u.steering_type)} is not one of ${STEERING_TYPES.join('|')}`);
    }
    if (seen.has(u.rule_id)) return inconsistent(`unexercised[${i}] repeats ${u.rule_id} — a rule is unexercised once or not at all`);
    seen.add(u.rule_id);
    listedByType.set(u.steering_type, (listedByType.get(u.steering_type) ?? 0) + 1);
    if (fired.has(u.rule_id)) {
      return inconsistent(`unexercised[${i}] names ${u.rule_id}, which \`fired\` for ${fired.get(u.rule_id)} row(s) — a rule that fired for any sample is exercised, never unexercised`);
    }
  }
  if (rc.exercised < fired.size) {
    return inconsistent(
      `exercised ${rc.exercised} is below the ${fired.size} distinct rule id(s) the rows' \`fired\` name (${listSome([...fired.keys()].sort())}) — ` +
        'every blocking firing is an exercised rule, so exercised ≥ distinct fired (equality only when no non-blocking effect fired)',
    );
  }
  if (perType !== undefined) {
    const sumExercised = Object.values(perType).reduce((n, row) => n + row.exercised, 0);
    if (sumExercised !== rc.exercised) return contradictory(`per_type sums to ${sumExercised} exercised but exercised is ${rc.exercised}`);
    for (const t of [...new Set([...Object.keys(perType), ...listedByType.keys()])].sort()) {
      const counted = perType[t]?.unexercised;
      const listed = listedByType.get(t) ?? 0;
      if (counted === undefined) return contradictory(`unexercised lists ${listed} ${t} rule(s) but per_type carries no ${t} row`);
      if (counted !== listed) return contradictory(`per_type.${t}.unexercised is ${counted} but unexercised lists ${listed} ${t} rule(s)`);
    }
  }
  return null;
}

/**
 * Publish report.json + report.meta.json as ONE verifiable generation under `<dir>/.report.lock`:
 * the report gets the `generation` stamped in, is written first, and its exact published bytes are
 * hashed into the meta (`report_sha256`) beside the same `generation` and the run provenance. A
 * reader that verifies (`readPublishedReport`) can never pair a report with a meta from another
 * generation: an interruption between the two renames, or two publishers racing, leaves a pair
 * that fails the hash or the generation check by construction. The pair is read back VERIFIED
 * while the lock is still held — a publisher that verified after releasing it could read a
 * concurrent publisher's half-renamed pair (its report landed, its meta not yet) and refuse its
 * own publication as torn. Returns what a reader sees: `{ report, meta }`.
 */
export function publishReport(outDir, report, provenance) {
  return withPublicationLock(join(outDir, REPORT_LOCK), 'run', (generation) => {
    const text = publishJson(join(outDir, 'report.json'), { ...report, generation }, generation);
    const meta = { generation, report_sha256: sha256(text), ...provenance };
    publishJson(join(outDir, 'report.meta.json'), meta, generation);
    return readPublishedReport(outDir);
  });
}

/**
 * The published report pair, VERIFIED: `meta.report_sha256` must equal the sha256 of the report
 * bytes on disk, and both files must carry the same `generation`. A mismatch is a named refusal
 * (a torn publication — report and meta from different generations — or a foreign report), never
 * a report read as if its meta described it. Missing files are a usage error.
 */
export function readPublishedReport(outDir) {
  const reportPath = join(outDir, 'report.json');
  const metaPath = join(outDir, 'report.meta.json');
  for (const p of [reportPath, metaPath]) {
    if (!existsSync(p)) throw new UsageError(`${p} is missing — run \`run ${outDir}\` first`);
  }
  const text = readFileSync(reportPath, 'utf8');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new RefusalError(`${metaPath} is not a report meta object`);
  const actual = sha256(text);
  if (meta.report_sha256 !== actual) {
    throw new RefusalError(
      `report_sha256 mismatch: ${metaPath} describes ${meta.report_sha256} but ${reportPath} hashes to ${actual} — a torn publication (report and meta from different generations) or a foreign report; re-run \`run ${outDir}\``,
    );
  }
  const report = JSON.parse(text);
  if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new RefusalError(`${reportPath} is not a report object`);
  if (report.generation !== meta.generation) {
    throw new RefusalError(
      `generation mismatch: ${reportPath} is generation ${JSON.stringify(report.generation)} but ${metaPath} says ${JSON.stringify(meta.generation)} — the meta was edited or does not belong to this report; re-run \`run ${outDir}\``,
    );
  }
  return { report, meta };
}

/**
 * `run <dir>`: verify the published samples against the selected pin (`readPublishedSamples`) —
 * BEFORE the engine is even probed — then resolve the engine ONCE (`resolveExecutable`: the OS's
 * own search, an empty PATH entry being the cwd, an executable regular file required; nothing
 * resolvable = SKIP) and spawn THAT absolute path for everything that follows — the file hashed
 * into the provenance (realpath + sha256, checked again after the run) is the file that ran. Only
 * when it answers `--version` cleanly (a resolved file that will not execute, any other spawn
 * error or a non-zero exit = a tool FAILURE, never a run recorded under an unknown engine),
 * ingest the doctrine seed into a TEMP rules store, read the ingested rules back
 * (`rules list --include-retired --json`) for the rule-snapshot identity BEFORE that store is
 * deleted, and `rules eval` EXACTLY the verified samples, staged as a one-file corpus DIR inside a
 * fresh private mkdtemp (the engine's `--corpus` takes a directory of sample *.json files or an
 * `evals:` scope, never a file — and it loads EVERY *.json in the directory it is given, so the
 * staging dir is never shared or reused) with a TEMP knowledge db. Every one of those later spawns
 * is checked for a spawn ERROR before its exit status or output is read (`spawnFailure`): an engine
 * removed (ENOENT) or made non-executable (EACCES) after the probe answered, a missing interpreter,
 * a resource fault — `spawnSync` then returns `.error` with no process, no status and no output, and
 * that is a tool FAILURE naming the step, the errno and the executable, never a TypeError on the
 * missing output (codex round 7). The report is VERIFIED
 * (`verifyEngineReport`: exactly one row per staged sample, engine verdicts, `fired` arrays, a
 * summary that is the rows' tally — else a named tool failure, nothing published) and every row
 * stamped with its `payload_hash`; report + meta then publish as ONE generation (`publishReport`)
 * and are read back verified (`readPublishedReport`) while the publication lock is still held —
 * what is returned is what a reader would see, and a concurrent publisher's half-renamed pair can
 * never be mistaken for our own. Non-zero only when the tool itself fails, its report does not
 * verify, or the published samples do not verify.
 */
/**
 * Why a spawn of the RESOLVED engine did not run, or null when a process ran: `spawnSync` reports a
 * failure to start the process in `.error` and leaves `status`, `stdout` and `stderr` unset — there
 * was no process. The file resolved and answered `--version`, so this is the executable removed
 * (ENOENT) or made non-executable (EACCES) under the run, a script whose interpreter is gone, or a
 * resource fault (EAGAIN, EMFILE). Read BEFORE `status` or the outputs, so `.trim()` never runs on
 * undefined (codex round 7). The text is a tool failure naming the step, the errno and the file.
 */
export function spawnFailure(step, result, binary) {
  if (result.error === undefined) return null;
  return `${step} could not be executed (${result.error.code ?? 'spawn error'}) — ${binary}: ${result.error.message}`;
}

/** A finished engine step's exit for a failure message: `exit N`, or `signal SIG…` when it was killed. */
function exitOf(result) {
  return result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
}

/** A finished engine step's output for a failure message — stderr first, stdout as the fallback, never undefined. */
function outputOf(result) {
  return ((result.stderr || result.stdout) ?? '').trim() || '(no output)';
}

export function runEvals(outDir, rulesDir, pin, pinPath, coreBin = CORE_BIN) {
  assertPinIntegrity(pin, pinPath);
  const { samples, meta } = readPublishedSamples(outDir, pin);
  // The engine is resolved ONCE, with the OS's search semantics, and EVERY spawn below uses the
  // resolved absolute path — the file hashed into the provenance is the file that ran.
  const resolved = resolveExecutable(coreBin);
  if (resolved.error !== null) {
    // The LOOKUP failed (a PATH directory the process may not search, an I/O fault): which file a
    // spawn would run cannot be determined — a tool failure, never "not installed" (codex round 6).
    const e = resolved.error;
    return { failure: `${coreBin} could not be looked up on PATH: ${e.syscall} ${e.candidate} failed (${e.code}) — ${e.message}; which executable a spawn would run cannot be determined, so nothing is run and nothing is skipped` };
  }
  if (resolved.path === null && resolved.blocked === null) {
    return { skipped: `${coreBin} is not on PATH — nothing to run (install wicked-core to eval the corpus)` };
  }
  // `blocked`: a regular file of that name on the search path that is not executable — exec's
  // EACCES. Spawned anyway so the OS names the fault itself; never a SKIP.
  const binary = resolved.path ?? resolved.blocked;
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined) {
    // A RESOLVED file that cannot be executed is a tool failure, never "not installed": no execute
    // bit (EACCES), a script whose interpreter is missing (ENOENT), a file removed under us.
    return { failure: `${coreBin} --version could not be executed (${probe.error.code ?? 'spawn error'}) — ${binary}: ${probe.error.message}` };
  }
  if (probe.status !== 0) {
    return { failure: `${coreBin} --version exited ${probe.status}: ${(probe.stderr || probe.stdout).trim() || '(no output)'}` };
  }
  const engineVersion = probe.stdout.trim();
  if (engineVersion === '') return { failure: `${coreBin} --version printed nothing — refusing to record a run under an unknown engine version` };
  if (!existsSync(rulesDir)) throw new UsageError(`rules seed dir ${rulesDir} does not exist (pass --rules <dir>)`);
  const buildHash = () => `sha256:${sha256Hex(readFileSync(binary))}`;
  const engine = { version: engineVersion, build: { path: binary, sha256: buildHash() } };
  const rulesSeed = seedDirIdentity(rulesDir);
  // mkdtemp is private (0700) and fresh: the rules db, the knowledge db and the staged corpus
  // live here and nowhere else; the whole tree is removed however the run ends.
  const tmp = mkdtempSync(join(tmpdir(), 'evals-internal-corpus-'));
  try {
    const rulesDb = join(tmp, 'rules.db');
    const knowledgeDb = join(tmp, 'knowledge.db');
    const ingest = spawnSync(binary, ['rules', 'ingest', rulesDir, '--db', rulesDb], { encoding: 'utf8' });
    // `.error` FIRST: a spawn that never produced a process has no status and no output to read.
    const ingestSpawn = spawnFailure('rules ingest', ingest, binary);
    if (ingestSpawn !== null) return { failure: ingestSpawn, engine: engineVersion };
    if (ingest.status !== 0) {
      return { failure: `rules ingest failed (${exitOf(ingest)}): ${outputOf(ingest)}`, engine: engineVersion };
    }
    // The rule snapshot the run is judged by — read back from the store BEFORE it is deleted.
    const listed = spawnSync(binary, ['rules', 'list', '--db', rulesDb, '--include-retired', '--json'], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    const rulesIdentity = rulesIdentityFrom(listed, coreBin, rulesSeed);
    if (rulesIdentity.failure !== undefined) return { failure: rulesIdentity.failure, engine: engineVersion };
    const corpusDir = join(tmp, 'corpus');
    mkdirSync(corpusDir);
    writeFileSync(join(corpusDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
    const evalRun = spawnSync(binary, ['rules', 'eval', '--db', rulesDb, '--knowledge-db', knowledgeDb, '--corpus', corpusDir, '--json'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
    });
    const evalSpawn = spawnFailure('rules eval', evalRun, binary);
    if (evalSpawn !== null) return { failure: evalSpawn, engine: engineVersion };
    if (evalRun.status !== 0) {
      return { failure: `rules eval failed (${exitOf(evalRun)}): ${outputOf(evalRun)}`, engine: engineVersion };
    }
    let report;
    try {
      report = JSON.parse(evalRun.stdout);
    } catch (err) {
      return { failure: `rules eval printed no JSON report: ${err.message}\n${evalRun.stdout.slice(0, 400)}`, engine: engineVersion };
    }
    const refused = verifyEngineReport(report, samples);
    if (refused !== null) return { failure: refused, engine: engineVersion };
    // The build hashed before the run must be the build that ran it: a binary replaced under the
    // run (an upgrade racing the eval) is a tool failure, never a report attributed to either.
    const after = buildHash();
    if (after !== engine.build.sha256) {
      return { failure: `the engine binary ${binary} changed during the run (${engine.build.sha256} before, ${after} after) — refusing to attribute the report to either build; re-run`, engine: engineVersion };
    }
    // Published AND read back verified under the one lock — what is returned is what a reader sees.
    const published = publishReport(outDir, report, {
      pin_hash: meta.pin_hash,
      samples_hash: meta.samples_hash,
      corpus_name: meta.corpus_name,
      samples_generation: meta.generation,
      engine,
      rules_identity: rulesIdentity.identity,
      rules_seed: rulesSeed,
    });
    return { report: published.report, meta: published.meta, engine: engineVersion };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = { pin: DEFAULT_PIN_PATH, 'source-root': process.env['WICKED_SOURCE_ROOT'] ?? resolve(REPO_ROOT, '..'), 'known-bad': DEFAULT_KNOWN_BAD_PATH, rules: undefined };
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!(name in flags)) throw new UsageError(`unknown flag ${a}`);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
      flags[name] = value;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  const needsDir = mode === 'materialize' || mode === 'samples' || mode === 'run';
  if (!['pin', 'check', 'materialize', 'samples', 'run'].includes(mode) || positional.length !== (needsDir ? 1 : 0)) {
    throw new UsageError('usage: evals-internal-corpus.mjs <pin|check> | <materialize|samples|run> <dir>  [--pin <file>] [--source-root <dir>] [--known-bad <file>] [--rules <dir>]');
  }
  return {
    mode,
    dir: positional[0] === undefined ? undefined : resolve(positional[0]),
    pinPath: resolve(flags.pin),
    sourceRoot: resolve(flags['source-root']),
    knownBadPath: resolve(flags['known-bad']),
    rulesDir: flags.rules === undefined ? undefined : resolve(flags.rules),
  };
}

function printSummary(report) {
  const s = report.summary ?? {};
  console.log(`summary: total ${s.total} · caught ${s.caught} · gaps ${s.gaps} · false_positives ${s.false_positives} · degraded ${JSON.stringify(report.degraded ?? null)}`);
  if (report.rule_coverage === undefined) {
    console.log('rule_coverage: not reported by this engine (predates core #394)');
    return;
  }
  const rc = report.rule_coverage;
  // `exercised` counts every rule any claim fired, blocking or not; the rows' `fired` is the
  // blocking subset — the difference is what fired by a non-blocking effect (`warn`) alone.
  const blocking = new Set((report.results ?? []).flatMap((row) => row.fired ?? [])).size;
  const nonBlocking = rc.exercised > blocking ? `; ${rc.exercised - blocking} exercised by a non-blocking effect only` : '';
  const recallOnly = Number.isInteger(rc.recall_only) ? ` · recall_only ${rc.recall_only}` : '';
  console.log(`rule_coverage: exercised ${rc.exercised} (${blocking} distinct rule id(s) fired blocking across the rows${nonBlocking}) · unexercised ${rc.unexercised.length}${recallOnly}`);
  for (const u of rc.unexercised) console.log(`  unexercised ${u.rule_id} (${u.steering_type})`);
}

function main(argv) {
  const { mode, dir, pinPath, sourceRoot, knownBadPath, rulesDir } = parseArgs(argv);
  if (mode === 'pin') {
    const pin = buildPin(pinPath, sourceRoot);
    publishJson(pinPath, pin);
    console.log(`evals-internal-corpus pin — ${pin.repos.length} repos re-resolved from ${sourceRoot} into ${pinPath}`);
    for (const r of pin.repos) {
      console.log(`  pinned    ${r.repo} ${r.tag} @ ${r.commit_sha.slice(0, SHORT_SHA_LEN)} · window ${r.action_window_from_tag}..${r.tag} = ${r.commits} commits${r.notes.startsWith('SHORTFALL') ? ' (SHORTFALL — see notes)' : ''}`);
    }
    console.log(`evals-internal-corpus: pin_hash ${pin.pin_hash}`);
    return EXIT_OK;
  }
  const pin = readPin(pinPath);
  if (mode === 'check') {
    assertPinIntegrity(pin, pinPath);
    const { drift, ok } = checkPin(pin, sourceRoot);
    console.log(`evals-internal-corpus check — ${sourceRoot} against ${pinPath}`);
    for (const repo of ok) console.log(`  ok        ${repo}`);
    for (const d of drift) console.log(`  DRIFT     ${d.repo} — ${d.reason}: ${d.detail}`);
    if (drift.length > 0) {
      const names = [...new Set(drift.map((d) => d.repo))];
      console.error(`evals-internal-corpus: FAIL — ${names.length} drifted repo(s): ${names.join(', ')}`);
      return EXIT_DRIFT;
    }
    console.log(`evals-internal-corpus: OK — ${pin.repos.length} repos match pin_hash ${pin.pin_hash}`);
    return EXIT_OK;
  }
  if (mode === 'materialize') {
    const receipt = materialize(pin, pinPath, sourceRoot, dir, (line) => console.log(`  ${line}`));
    for (const r of receipt.repos) console.log(`  archived  ${r.repo}@${r.tag} (${r.commit_sha.slice(0, SHORT_SHA_LEN)}) → ${r.path}`);
    console.log(`evals-internal-corpus: materialized ${receipt.repos.length} repos under ${dir} (pin_hash ${receipt.pin_hash}) · generation ${receipt.generation}`);
    return EXIT_OK;
  }
  if (mode === 'samples') {
    const { samples, meta } = deriveSamples(pin, pinPath, sourceRoot, readKnownBad(knownBadPath));
    const published = publishSamples(dir, samples, meta);
    for (const w of meta.windows) console.log(`  derived   ${w.repo} ${w.from}..${w.tag} = ${w.commits} samples`);
    console.log(`  steering  ${Object.entries(meta.steering_types).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
    console.log(
      `evals-internal-corpus: ${meta.total} samples (${meta.bad} bad) → ${join(dir, 'samples.json')} · samples_hash ${meta.samples_hash} · corpus ${meta.corpus_name} · generation ${published.generation}`,
    );
    return EXIT_OK;
  }
  // run
  const result = runEvals(dir, rulesDir ?? join(sourceRoot, DEFAULT_RULES_SEED_REL), pin, pinPath);
  if (result.skipped !== undefined) {
    console.log(`evals-internal-corpus run: SKIP — ${result.skipped}`);
    return EXIT_OK;
  }
  if (result.failure !== undefined) {
    console.error(`evals-internal-corpus run: TOOL FAILURE (${result.engine ?? 'engine version unknown'}) — ${result.failure}`);
    return EXIT_DRIFT;
  }
  console.log(`evals-internal-corpus run (${result.engine}) → ${join(dir, 'report.json')} · generation ${result.meta.generation} · report_sha256 ${result.meta.report_sha256}`);
  console.log(`provenance: engine build ${result.meta.engine.build.sha256} (${result.meta.engine.build.path}) · rules identity ${result.meta.rules_identity.method} ${result.meta.rules_identity.sha256}`);
  printSummary(result.report);
  return EXIT_OK;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`evals-internal-corpus: ${message}`);
    process.exitCode = err instanceof DriftError || err instanceof RefusalError || err instanceof ToolError ? EXIT_DRIFT : EXIT_USAGE;
  }
}
