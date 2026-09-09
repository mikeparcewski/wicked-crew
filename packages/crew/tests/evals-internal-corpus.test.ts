// evals-internal-corpus (scripts/evals-internal-corpus.mjs) — the INTERNAL evals corpus: five
// wicked repos at pinned prior release tags, with an action window of real commits behind each.
//
// Proven over FIXTURE mini-repos with tags (never the sibling checkouts): the pin resolves shas
// and windows by the rule (>= min_commits, capped at max_age_days before the tag's own date;
// shortfall recorded, never widened); `check` fails closed on sha drift (a re-cut tag), on a
// hand-edited pin AND on a SHALLOW checkout (a depth-1 clone plus a depth-1 fetch of the from-tag
// resolves both pinned tags while the window between them is missing — the codex round-3 finding:
// fewer samples under the unchanged pin identity); `samples` compares each window's derived commit
// and sample counts with the pin's `commits` (a hand-edited count is refused by name) and refuses a
// `.git/shallow` graft inside the window; `samples` derives one EvalSample per window commit that the REAL crew zod
// schema accepts, infers steering_type from the explicit path table (unsure ⇒ development),
// honors the known-bad allowlist, fails closed on a stale entry AND on a missing / malformed
// allowlist file (never an empty one), and derives byte-identical samples under two different
// operator git configurations (rename detection, order file, quoting, output encoding pinned);
// `materialize` refuses a pin whose sha no longer matches, a `repo` that is not one safe path
// segment, and a symlinked destination (containment under the realpath of the root), pins the
// operator's git attributes away and verifies the extracted tree against `ls-tree` (an
// un-overridable `export-ignore` is a named refusal), extracts + verifies EVERY repo into a staging
// dir beside its destination under `.materialize.lock` and swaps only after all verified (a failed
// repeat leaves the previous trees and receipt byte-intact, a failed first run leaves no receipt,
// a receipt beside a missing tree is removed, two concurrent materializations never interleave;
// every `.prev` backup is kept until the receipt is published and a fault DURING the swap or the
// receipt write is rolled back — destinations byte-identical, receipt intact-or-absent, never a
// receipt over a damaged tree — via a vitest-only fault hook, codex round 4); `check` refuses a
// checkout carrying git REPLACEMENT refs (`refs/replace/*` — a window commit rewritten with the
// same parents, tag shas and counts but another message + tree, codex round 4) and every git the
// script runs is replacement-blind; filenames with leading/trailing spaces,
// tabs, quotes, backslashes and newlines round-trip EXACTLY into `signals.files` (NUL-delimited
// extraction, never trimmed) and the steering-type inference sees the real paths; samples are
// validated by the ROUTE's own zod schema (no mirror — what the route rejects, `samples`/`run`
// reject before the engine is invoked); `samples` publishes atomically (tmp+rename under a lock,
// one generation stamp); `run` skips ONLY on ENOENT (any other probe error or a non-zero
// `--version` is a tool failure), fails loud when the tool fails, verifies samples.meta.json
// against samples.json AND the pin before the engine is probed, stages EXACTLY the pinned samples
// in a fresh private dir, VERIFIES the engine's report before publication (exactly one row per
// staged sample — no duplicate, extra or missing id — engine verdicts, `fired` arrays, a summary
// that is the rows' tally, every row CONSISTENT with its sample's kind — `expected` by kind, never
// `gap` on a good sample or `false_positive` on a bad one, `fired` non-empty iff a blocking
// verdict fired — `degraded` present, `rule_coverage` absent or well-formed; an EMPTY report, an
// impossible row and `rule_coverage: null` are refused by name, a valid all-gap report over BAD
// samples passes),
// stamps every result row with its sample's `payload_hash`, and publishes
// report + meta as ONE verifiable generation carrying complete provenance (engine build identity,
// rule-snapshot identity with its method, pin/samples hashes, the report's own sha256) — a torn
// pair is refused on read (a fake binary stands in for the engine). Plus the committed pin's
// structural facts.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ImportEvalCorpusSchema } from '../src/api/testing.js';
import { samplePayloadHash } from '../src/api/eval-sample.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/evals-internal-corpus.mjs', import.meta.url));
const COMMITTED_PIN = fileURLToPath(new URL('../../../e2e/corpus/wicked-internal-corpus.json', import.meta.url));
const COMMITTED_KNOWN_BAD = fileURLToPath(new URL('../../../e2e/corpus/known-bad.json', import.meta.url));

interface PinRepo {
  repo: string;
  remote: string;
  tag: string;
  commit_sha: string;
  tag_date: string;
  action_window_from_tag: string;
  action_window_from_sha: string;
  action_window_from_date: string;
  commits: number;
  notes: string;
}
interface Pin {
  description: string;
  release_tag_pattern: string;
  window_rule: { min_commits: number; max_age_days: number };
  repos: PinRepo[];
  pin_hash: string;
}
interface Sample {
  id: string;
  description: string;
  kind: 'good' | 'bad';
  steering_type: string;
  signals: { files: string[]; content: string };
}
interface SamplesMeta {
  pin_hash: string;
  samples_hash: string;
  corpus_name: string;
  total: number;
  bad: number;
  steering_types: Record<string, number>;
  windows: { repo: string; from: string; tag: string; commits: number }[];
  /** The publication stamp — shared by the samples/meta tmp files of ONE publication. */
  generation: string;
}
/** `report.meta.json` — the run's complete provenance (what S17 keys a comparison on). */
interface ReportMeta {
  generation: string;
  report_sha256: string;
  pin_hash: string;
  samples_hash: string;
  corpus_name: string;
  samples_generation: string;
  engine: { version: string; build: { path: string; sha256: string } };
  rules_identity: { method: 'engine-list' | 'seed-dir'; sha256: string; rule_count: number | null; command?: string; reason?: string };
  rules_seed: { dir: string; sha256: string; files: number };
}
interface ReportRow {
  sample: { id: string; description: string; kind: 'good' | 'bad'; steering_type: string; payload_hash?: string };
  expected: string;
  fired: string[];
  verdict: string;
}
interface Report {
  generation: string;
  results: ReportRow[];
  summary: { total: number; caught: number; gaps: number; false_positives: number };
  /** ALWAYS present on the wire (the engine serializes the Option) — null, or `facet-only`. */
  degraded: 'facet-only' | null;
  rule_coverage?: { exercised: number; unexercised: unknown[] };
}
/** The script's exported pure functions (typed here — the file is plain JS). */
interface CorpusModule {
  pinHash: (repos: PinRepo[]) => string;
  samplesHash: (samples: Sample[]) => string;
  classifyPath: (path: string) => string | null;
  inferSteeringType: (files: string[]) => string;
  corpusName: (pinHash: string) => string;
  isSafeSegment: (name: string) => boolean;
  validateSample: (sample: unknown) => string[];
  parseNulPaths: (tail: string, checkout: string, sha: string) => string[];
  resolveWindow: (checkout: string, tag: string, rule: { min_commits: number; max_age_days: number }, table?: Map<string, { sha: string; date: string }>) => unknown;
  readPublishedReport: (outDir: string) => { report: Report; meta: ReportMeta };
  rulesSnapshotHash: (rules: unknown[]) => string;
  seedDirIdentity: (dir: string) => { dir: string; sha256: string; files: number };
  shallowEvidence: (checkout: string) => string[];
  replaceRefs: (checkout: string) => string[];
  windowCommits: (checkout: string, fromSha: string, tagSha: string) => { sha: string; subject: string; body: string; files: string[] }[];
  verifyEngineReport: (report: unknown, samples: Sample[]) => string | null;
  ENGINE_DEGRADED_MODES: readonly string[];
  FAULT_ENV: string;
  UsageError: new (message: string) => Error;
  RefusalError: new (message: string) => Error;
  RELEASE_TAG_RE: RegExp;
  SAFE_SEGMENT_RE: RegExp;
  GIT_LOG_CONFIG: readonly string[];
  SAMPLES_LOCK: string;
  REPORT_LOCK: string;
  MATERIALIZE_LOCK: string;
  ENGINE_VERDICTS: readonly string[];
  STEERING_TYPES: readonly string[];
  CORE_BIN: string;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A content identity of a directory tree: sorted `[relative path, sha256]` pairs, hashed. */
function treeIdentity(root: string): string {
  const acc: [string, string][] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else acc.push([r, sha256(readFileSync(p))]);
    }
  };
  walk(root, '');
  acc.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify(acc));
}

/** Per-FILE scratch: the isolated gitconfig and the pristine fixture repos, built ONCE. */
let root: string;
let template: string;
/** Per-TEST scratch: a copy of the template repos (tests mutate them), the pin, the outputs. */
let fixture: string;
let sourceRoot: string;
let pinPath: string;
let knownBadPath: string;
let outDir: string;
/** Git isolated from the operator's global/system config (identity, signing, hooks, default
 *  branch) — spread over the armed process env so the hermetic guard's scan stays satisfied. */
let env: NodeJS.ProcessEnv;
/** A hostile-but-legal operator gitconfig: every knob the derivation must be independent of. */
let adversarialGitconfig: string;
/** An operator gitconfig whose `core.attributesFile` export-ignores README.md — what an unpinned
 *  `git archive` silently honors (materialization must not). */
let attributesGitconfig: string;

/** A fixed clock for the fixture commits: dates are what the age cap reasons over. */
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 86_400_000;
/** The per-test hooks below spawn the script (one node process + ~10 git processes). Alone that
 *  is ~1 s; under FULL-suite load on a saturated machine it once blew vitest's 15 s hook budget
 *  (`Hook timed out in 15000ms`), so the hooks carry their own budget — the same reason the
 *  fixture build moved into a 120 s `beforeAll`. */
const HOOK_TIMEOUT = 90_000;

// The ~30 git spawns that build the three repos run once per file (they blew the 15 s hook
// budget per test under full-suite load); each test then gets a byte copy of the pristine repos.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'evals-internal-corpus-'));
  writeFileSync(join(root, 'gitconfig'), '', 'utf8');
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_AUTHOR_NAME: 'evals-corpus-test',
    GIT_AUTHOR_EMAIL: 'evals-corpus@example.invalid',
    GIT_COMMITTER_NAME: 'evals-corpus-test',
    GIT_COMMITTER_EMAIL: 'evals-corpus@example.invalid',
  };
  template = join(root, 'template');
  mkdirSync(template, { recursive: true });
  // alpha: v0.1.0 (1 commit) → +2 → v0.2.0 (annotated) → +2 → v0.3.0. With min_commits 3 the
  // window walks past v0.2.0 (2 commits) to v0.1.0 (4 commits): the floor met on the 2nd tag.
  const alpha = initRepo(template, 'alpha', 0);
  tag(alpha, 'v0.1.0');
  commitFile(alpha, 'src/core.ts', 'feat: core', 1);
  commitFile(alpha, 'tests/core.test.ts', 'test: core', 2);
  tag(alpha, 'v0.2.0', { annotated: true });
  commitFile(alpha, 'src/more.ts', 'feat: more\n\nA body line.', 3);
  commitFile(alpha, 'src/again.ts', 'fix: again', 4);
  tag(alpha, 'v0.3.0');
  // beta: v0.1.0 → +1 → v0.2.0, nothing older: the floor CANNOT be met → shortfall recorded.
  const beta = initRepo(template, 'beta', 0);
  tag(beta, 'v0.1.0');
  commitFile(beta, 'README.md', 'docs: readme', 1);
  tag(beta, 'v0.2.0');
  // gamma: v0.1.0 is 400 days before v0.3.0 (past the 180-day cap), v0.2.0 is inside it with 1
  // commit: the walk stops at the cap → from = v0.2.0 with a shortfall naming the cap.
  const gamma = initRepo(template, 'gamma', -400);
  tag(gamma, 'v0.1.0');
  commitFile(gamma, 'a.ts', 'feat: a', -10);
  tag(gamma, 'v0.2.0');
  commitFile(gamma, 'b.ts', 'feat: b', 0);
  tag(gamma, 'v0.3.0');
  // A non-release tag that must be IGNORED by the walk (else beta's window would start here).
  tag(beta, 'api-types-v9.9.9');
  // delta: the git-configuration probe (pinned only by the config-independence test). v0.1.0 → a
  // RENAME (init.txt → moved.txt: with rename detection on, `--name-only` shows only the new path),
  // a TWO-FILE commit (an operator's diff.orderFile would reorder it), a NON-ASCII path + subject
  // (core.quotePath would octal-escape the path; i18n.logOutputEncoding would re-encode the
  // subject) → v0.2.0. Exactly 3 commits = the fixture floor.
  const delta = initRepo(template, 'delta', 0);
  tag(delta, 'v0.1.0');
  git(delta, 'mv', 'init.txt', 'moved.txt');
  commitStaged(delta, 'refactor: rename init', 1);
  writeFileSync(join(delta, 'zeta.ts'), 'z\n', 'utf8');
  writeFileSync(join(delta, 'alpha.ts'), 'a\n', 'utf8');
  git(delta, 'add', 'zeta.ts', 'alpha.ts');
  commitStaged(delta, 'feat: two files', 2);
  commitFile(delta, 'docs/ünïcode.md', 'docs: naïve ünïcode', 3);
  tag(delta, 'v0.2.0');
  // epsilon: the exact-filename probe. v0.1.0 → a commit touching ONE file in a directory whose
  // name has a LEADING SPACE (` tests/lead.ts`: the real path is not under `tests/`, so the honest
  // steering type is development — a trimmed path would read `tests/lead.ts` and say testing) → a
  // commit touching names with a trailing space, a tab, a backslash, a double quote and a NEWLINE
  // (git C-quotes every one of these under `--name-only` unless `-z` is given; `core.quotePath=
  // false` only stops the non-ASCII escaping) → v0.2.0. Names Windows cannot hold: the test that
  // pins them is skipped there.
  if (process.platform !== 'win32') {
    const epsilon = initRepo(template, 'epsilon', 0);
    tag(epsilon, 'v0.1.0');
    commitFile(epsilon, ' tests/lead.ts', 'feat: leading-space dir', 1);
    for (const name of ['trail.txt ', 'tab\there.txt', 'back\\slash.txt', '"quoted".txt', 'new\nline.txt']) {
      writeFileSync(join(epsilon, name), `${name}\n`, 'utf8');
    }
    git(epsilon, 'add', '-A');
    commitStaged(epsilon, 'feat: adversarial names', 2);
    commitFile(epsilon, 'plain.txt', 'feat: plain', 3);
    tag(epsilon, 'v0.2.0');
  }
  const exportIgnore = join(root, 'attributes-export-ignore');
  writeFileSync(exportIgnore, 'README.md export-ignore\n', 'utf8');
  attributesGitconfig = join(root, 'gitconfig-attributes');
  writeFileSync(attributesGitconfig, `[core]\n\tattributesFile = ${exportIgnore}\n`, 'utf8');
  const orderFile = join(root, 'orderfile');
  writeFileSync(orderFile, 'zeta*\n', 'utf8');
  adversarialGitconfig = join(root, 'gitconfig-adversarial');
  writeFileSync(
    adversarialGitconfig,
    [
      '[diff]',
      '\trenames = true',
      `\torderFile = ${orderFile}`,
      '\tmnemonicPrefix = true',
      '\tnoprefix = true',
      '\trelative = true',
      '\tignoreSubmodules = all',
      '[core]',
      '\tquotePath = true',
      '[log]',
      '\tshowSignature = true',
      '\tfollow = true',
      '\tdiffMerges = separate',
      '[i18n]',
      '\tlogOutputEncoding = ISO-8859-1',
      '',
    ].join('\n'),
    'utf8',
  );
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fixture = mkdtempSync(join(root, 'case-'));
  sourceRoot = join(fixture, 'source');
  cpSync(template, sourceRoot, { recursive: true });
  pinPath = join(fixture, 'pin', 'wicked-internal-corpus.json');
  knownBadPath = join(fixture, 'known-bad.json');
  outDir = join(fixture, 'out');
  // An EMPTY allowlist is a file that says so — a missing one is a usage error (fail-closed).
  writeFileSync(knownBadPath, JSON.stringify({ description: 'fixture allowlist', samples: {} }), 'utf8');
  writeConstants({
    alpha: 'v0.3.0',
    beta: 'v0.2.0',
    gamma: 'v0.3.0',
  });
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repo at `<base>/<name>` with one root commit dated `dayOffset` days from T0. */
function initRepo(base: string, name: string, dayOffset: number): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commitFile(dir, 'init.txt', 'init', dayOffset);
  return dir;
}

function commitFile(dir: string, path: string, message: string, dayOffset: number): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), `${message}\n`, 'utf8');
  git(dir, 'add', path);
  return commitStaged(dir, message, dayOffset);
}

/** Commit whatever is staged, dated `dayOffset` days from T0. */
function commitStaged(dir: string, message: string, dayOffset: number): string {
  const when = new Date(T0 + dayOffset * DAY).toISOString();
  // `env` already spreads process.env (the hermetic arming); re-stated here so the harness-hygiene
  // source scan sees the arming inside this inline literal.
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: dir,
    env: { ...process.env, ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(dir, 'rev-parse', 'HEAD');
}

function tag(dir: string, name: string, opts: { annotated?: boolean } = {}): void {
  if (opts.annotated) git(dir, 'tag', '-a', '-m', `release ${name}`, name);
  else git(dir, 'tag', name);
}

/** The constants a human commits: repo, remote, tag (+ the small fixture window rule). */
function writeConstants(tags: Record<string, string>, rule = { min_commits: 3, max_age_days: 180 }): void {
  mkdirSync(join(fixture, 'pin'), { recursive: true });
  writeFileSync(
    pinPath,
    JSON.stringify({
      description: 'fixture pin',
      window_rule: rule,
      repos: Object.entries(tags).map(([repo, t]) => ({ repo, remote: `https://example.invalid/${repo}.git`, tag: t })),
    }),
    'utf8',
  );
}

function run(mode: string, ...extra: string[]) {
  return runEnv({}, mode, ...extra);
}

/** `run` under the isolated env plus `override` (e.g. a different GIT_CONFIG_GLOBAL). `env` already
 *  spreads process.env (the hermetic arming); re-stated so the harness-hygiene scan sees it here. */
function runEnv(override: NodeJS.ProcessEnv, mode: string, ...extra: string[]) {
  return runFrom(sourceRoot, override, mode, ...extra);
}

/** `run` against ANOTHER source root (a shallow or a full clone of the fixture repos). `env`
 *  spreads process.env (the hermetic arming); re-stated so the harness-hygiene scan sees it here. */
function runFrom(source: string, override: NodeJS.ProcessEnv, mode: string, ...extra: string[]) {
  const args = [SCRIPT, mode, ...extra, '--pin', pinPath, '--source-root', source, '--known-bad', knownBadPath];
  const res = spawnSync(process.execPath, args, { env: { ...process.env, ...env, ...override }, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function readPin(path: string = pinPath): Pin {
  return JSON.parse(readFileSync(path, 'utf8')) as Pin;
}

function readSamples(): { samples: Sample[]; meta: SamplesMeta } {
  return {
    samples: JSON.parse(readFileSync(join(outDir, 'samples.json'), 'utf8')) as Sample[],
    meta: JSON.parse(readFileSync(join(outDir, 'samples.meta.json'), 'utf8')) as SamplesMeta,
  };
}

function pinOf(pin: Pin, repo: string): PinRepo {
  return pin.repos.find((r) => r.repo === repo)!;
}

/** Re-cut a tag onto a NEW commit — the drift every fail-closed path must catch. */
function moveTag(repo: string, tagName: string): string {
  const dir = join(sourceRoot, repo);
  const sha = commitFile(dir, 'moved.txt', 'chore: after the pin', 9);
  git(dir, 'tag', '-f', tagName, sha);
  return sha;
}

async function mod(): Promise<CorpusModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as CorpusModule;
}

describe('pin — the constant resolved once', () => {
  it('resolves every tag (annotated tags peel to the commit) and applies the window rule per repo', async () => {
    const p = run('pin');
    expect(p.status, p.stderr).toBe(0);
    const pin = readPin();
    expect(pin.repos.map((r) => r.repo)).toEqual(['alpha', 'beta', 'gamma']); // codepoint order
    expect(pin.window_rule).toEqual({ min_commits: 3, max_age_days: 180 });
    expect(pin.release_tag_pattern).toBe((await mod()).RELEASE_TAG_RE.source);

    const alpha = pinOf(pin, 'alpha');
    expect(alpha.commit_sha).toBe(git(join(sourceRoot, 'alpha'), 'rev-parse', 'v0.3.0^{commit}'));
    expect(alpha.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    // v0.2.0 (annotated) holds only 2 commits < 3 → walk on to v0.1.0 (4 commits): floor met.
    expect(alpha.action_window_from_tag).toBe('v0.1.0');
    expect(alpha.action_window_from_sha).toBe(git(join(sourceRoot, 'alpha'), 'rev-parse', 'v0.1.0^{commit}'));
    expect(alpha.commits).toBe(4);
    expect(alpha.notes).toMatch(/^window v0\.1\.0\.\.v0\.3\.0 = 4 commits \(>= 3 floor met after walking back 2 release tags\)$/);
    expect(alpha.tag_date).toBe('2026-01-05');
    expect(alpha.action_window_from_date).toBe('2026-01-01');

    // beta: the only older release tag holds 1 commit and nothing older exists → SHORTFALL, not
    // widened; the `api-types-v9.9.9` tag was never considered a release tag.
    const beta = pinOf(pin, 'beta');
    expect(beta.action_window_from_tag).toBe('v0.1.0');
    expect(beta.commits).toBe(1);
    expect(beta.notes).toMatch(/^SHORTFALL: window v0\.1\.0\.\.v0\.2\.0 = 1 commits < 3 floor; v0\.1\.0 is the oldest release tag inside 180 days of 2026-01-02 \(no older release tag exists\) — not widened past the cap$/);

    // gamma: v0.1.0 is 400 days back — past the cap — so the walk stops at v0.2.0 (1 commit).
    const gamma = pinOf(pin, 'gamma');
    expect(gamma.action_window_from_tag).toBe('v0.2.0');
    expect(gamma.commits).toBe(1);
    const gammaOldest = git(join(sourceRoot, 'gamma'), 'log', '-1', '--format=%cs', 'v0.1.0');
    expect(gamma.notes).toBe(
      `SHORTFALL: window v0.2.0..v0.3.0 = 1 commits < 3 floor; v0.2.0 is the oldest release tag inside 180 days of 2026-01-01 ` +
        `(next older v0.1.0 (${gammaOldest}) is past the cap) — not widened past the cap`,
    );

    // The hash is the content identity, recomputable from the repos alone.
    expect(pin.pin_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await mod()).pinHash(pin.repos)).toBe(pin.pin_hash);
    expect(p.stdout).toContain(`pin_hash ${pin.pin_hash}`);
    expect(p.stdout).toMatch(/pinned\s+beta v0\.2\.0 .* \(SHORTFALL — see notes\)/);
  });

  it('is idempotent on an unchanged tag — dates are the tag\'s, not today\'s, so re-pinning is byte-identical', () => {
    expect(run('pin').status).toBe(0);
    const first = readFileSync(pinPath, 'utf8');
    expect(run('pin').status).toBe(0);
    expect(readFileSync(pinPath, 'utf8')).toBe(first);
  });

  it('refuses a missing tag and a non-release tag as usage errors', () => {
    writeConstants({ alpha: 'v9.9.9' });
    const missing = run('pin');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/alpha: tag v9\.9\.9 does not exist/);

    writeConstants({ beta: 'api-types-v9.9.9' });
    const notRelease = run('pin');
    expect(notRelease.status).toBe(2);
    expect(notRelease.stderr).toMatch(/beta tag api-types-v9\.9\.9 is not a release tag/);
  });

  it('resolveWindow() refuses a tag missing from the tag table as a UsageError naming the tag and the checkout — before any destructuring, never a TypeError (Copilot)', async () => {
    const m = await mod();
    const checkout = join(sourceRoot, 'alpha');
    const rule = { min_commits: 3, max_age_days: 180 };
    // A caller-supplied table without the tag.
    let fromEmpty: unknown;
    try {
      m.resolveWindow(checkout, 'v9.9.9', rule, new Map());
    } catch (e) {
      fromEmpty = e;
    }
    expect(fromEmpty).toBeInstanceOf(m.UsageError);
    expect((fromEmpty as Error).message).toBe(`v9.9.9: tag does not exist in ${checkout} (not in its tag table) — a window can only open from an existing release tag`);
    // The checkout's REAL table, a tag that does not exist: the same UsageError, same wording.
    let fromReal: unknown;
    try {
      m.resolveWindow(checkout, 'v9.9.9', rule);
    } catch (e) {
      fromReal = e;
    }
    expect(fromReal).toBeInstanceOf(m.UsageError);
    expect((fromReal as Error).message).toMatch(/^v9\.9\.9: tag does not exist in /);
  });
});

describe('check — the tags still resolve to the pinned shas', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  }, HOOK_TIMEOUT);

  it('passes on an untouched source and names the pin_hash', () => {
    const c = run('check');
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toMatch(/ok\s+alpha/);
    expect(c.stdout).toMatch(/ok\s+beta/);
    expect(c.stdout).toMatch(/ok\s+gamma/);
    expect(c.stdout).toContain(`OK — 3 repos match pin_hash ${readPin().pin_hash}`);
  });

  it('fails closed (exit 1) when a pinned tag was re-cut onto another commit — names that repo only', () => {
    const pinned = pinOf(readPin(), 'alpha').commit_sha;
    const moved = moveTag('alpha', 'v0.3.0');
    const c = run('check');
    expect(c.status).toBe(1);
    expect(c.stdout).toContain(`DRIFT     alpha — tag: v0.3.0 resolves to ${moved.slice(0, 12)} != pinned ${pinned.slice(0, 12)}`);
    expect(c.stdout).toMatch(/ok\s+beta/);
    expect(c.stderr).toMatch(/FAIL — 1 drifted repo\(s\): alpha$/m);
  });

  it('fails closed when the window-FROM tag moved or a tag is gone, and on a missing checkout', () => {
    git(join(sourceRoot, 'alpha'), 'tag', '-d', 'v0.1.0');
    moveTag('gamma', 'v0.2.0');
    rmSync(join(sourceRoot, 'beta'), { recursive: true, force: true });
    const c = run('check');
    expect(c.status).toBe(1);
    expect(c.stdout).toMatch(/DRIFT\s+alpha — from: v0\.1\.0 resolves to NOTHING \(tag gone\)/);
    expect(c.stdout).toMatch(/DRIFT\s+gamma — from: v0\.2\.0 resolves to [0-9a-f]{12} != pinned/);
    expect(c.stdout).toMatch(/DRIFT\s+beta — missing: no source checkout for beta/);
    expect(c.stderr).toMatch(/FAIL — 3 drifted repo\(s\): alpha, beta, gamma$/m);
  });

  it('rejects a hand-edited pin (stored pin_hash no longer matches its own repos) — exit 2, never a pass', () => {
    const pin = readPin();
    pinOf(pin, 'alpha').commit_sha = '0'.repeat(40);
    writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
    const c = run('check');
    expect(c.status).toBe(2);
    expect(c.stderr).toMatch(/pin_hash mismatch/);
    expect(c.stderr).toMatch(/moving a tag is a deliberate PR/);
  });

  it('S14i: a SHALLOW checkout is refused by name (exit 1) even when BOTH pinned tags resolve to the pinned shas — a depth-1 clone plus a depth-1 fetch of the from-tag; the same repo cloned in FULL passes and derives the pinned counts', () => {
    const pinned = pinOf(readPin(), 'alpha');
    expect(pinned.commits).toBe(4);
    const shallowRoot = join(fixture, 'shallow-source');
    mkdirSync(shallowRoot, { recursive: true });
    // `--depth` is ignored on a plain local path (git says so); a file:// URL makes it a real shallow clone.
    git(shallowRoot, 'clone', '-q', '--depth', '1', pathToFileURL(join(sourceRoot, 'alpha')).href, 'alpha');
    git(join(shallowRoot, 'alpha'), 'fetch', '-q', '--depth', '1', 'origin', 'tag', 'v0.1.0');
    for (const other of ['beta', 'gamma']) cpSync(join(sourceRoot, other), join(shallowRoot, other), { recursive: true });
    // Both tags resolve to the PINNED shas — no sha comparison can see what is wrong…
    expect(git(join(shallowRoot, 'alpha'), 'rev-parse', 'v0.3.0^{commit}')).toBe(pinned.commit_sha);
    expect(git(join(shallowRoot, 'alpha'), 'rev-parse', 'v0.1.0^{commit}')).toBe(pinned.action_window_from_sha);
    // …while the window between them holds 1 commit where the pin recorded 4 (codex round 3 on the
    // real corpus: 240 samples instead of 293, one crew commit instead of 54, same pin identity).
    expect(git(join(shallowRoot, 'alpha'), 'rev-list', '--count', 'v0.1.0..v0.3.0')).toBe('1');
    const c = runFrom(shallowRoot, {}, 'check');
    expect(c.status).toBe(1);
    expect(c.stdout).toMatch(
      /DRIFT\s+alpha — shallow: the checkout has INCOMPLETE history \(`git rev-parse --is-shallow-repository` says true; .+?[\\/]shallow exists\) — a pinned window cannot be walked over a shallow clone; unshallow it \(git fetch --unshallow\) or use a full clone/,
    );
    expect(c.stdout).toMatch(/ok\s+beta/);
    expect(c.stderr).toMatch(/FAIL — 1 drifted repo\(s\): alpha$/m);
    // The derivation refuses the same way, before a single sample is derived.
    const s = runFrom(shallowRoot, {}, 'samples', outDir);
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/refusing to derive from the wrong history:\n\s+DRIFT\s+alpha — shallow: the checkout has INCOMPLETE history/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
    // The SAME repo cloned in full: not shallow, `check` passes, and the derived counts are the pin's.
    const fullRoot = join(fixture, 'full-source');
    mkdirSync(fullRoot, { recursive: true });
    git(fullRoot, 'clone', '-q', pathToFileURL(join(sourceRoot, 'alpha')).href, 'alpha');
    for (const other of ['beta', 'gamma']) cpSync(join(sourceRoot, other), join(fullRoot, other), { recursive: true });
    expect(git(join(fullRoot, 'alpha'), 'rev-parse', '--is-shallow-repository')).toBe('false');
    const full = runFrom(fullRoot, {}, 'check');
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout).toMatch(/ok\s+alpha/);
    const derived = runFrom(fullRoot, {}, 'samples', outDir);
    expect(derived.status, derived.stderr).toBe(0);
    const { meta } = readSamples();
    expect(meta.windows.find((w) => w.repo === 'alpha')!.commits).toBe(pinned.commits);
    expect(meta.total).toBe(6);
  });

  it("S14j: a git REPLACEMENT ref (a window commit `git replace`d by one with the SAME parents but another message + tree) leaves both tag shas and `rev-list --count` exactly the pin's while an unpinned `git log` reads the replacement — refused by name (exit 1) by `check` and `samples`, exit 2 by `pin`; every git the script runs is replacement-blind; with the ref deleted the derived samples are byte-identical to the pre-replace run", async () => {
    const m = await mod();
    const alphaDir = join(sourceRoot, 'alpha');
    const pinned = pinOf(readPin(), 'alpha');
    // The reference derivation BEFORE any replacement.
    expect(run('samples', outDir).status).toBe(0);
    const before = readFileSync(join(outDir, 'samples.json'), 'utf8');
    expect(m.replaceRefs(alphaDir)).toEqual([]);
    // Replace the window commit "feat: more" (v0.3.0~1) with a commit of the SAME parent but v0.1.0's
    // tree and another message — the parents, both tags and the count do not move.
    const target = git(alphaDir, 'rev-parse', 'v0.3.0~1');
    expect(git(alphaDir, 'log', '-1', '--format=%s', target)).toBe('feat: more');
    const replacement = git(alphaDir, 'commit-tree', git(alphaDir, 'rev-parse', 'v0.1.0^{tree}'), '-p', git(alphaDir, 'rev-parse', `${target}^`), '-m', 'evil: rewritten through refs/replace');
    git(alphaDir, 'replace', target, replacement);
    // The pin's facts are UNCHANGED — no sha or count comparison can see what is wrong…
    expect(git(alphaDir, 'rev-parse', 'v0.3.0^{commit}')).toBe(pinned.commit_sha);
    expect(git(alphaDir, 'rev-parse', 'v0.1.0^{commit}')).toBe(pinned.action_window_from_sha);
    expect(git(alphaDir, 'rev-list', '--count', 'v0.1.0..v0.3.0')).toBe(String(pinned.commits));
    expect(m.shallowEvidence(alphaDir)).toEqual([]);
    // …while an UNPINNED log reads the replacement (the control — else the refusal proves nothing).
    expect(git(alphaDir, 'log', '--format=%s', 'v0.1.0..v0.3.0').split('\n')).toEqual(['fix: again', 'evil: rewritten through refs/replace', 'test: core', 'feat: core']);
    expect(git(alphaDir, 'log', '-1', '--format=%s', '--name-only', target)).not.toContain('src/more.ts');
    // The script's own git is replacement-blind (`--no-replace-objects` + GIT_NO_REPLACE_OBJECTS=1):
    // the window derives the ORIGINAL commit even with the ref present.
    expect(m.replaceRefs(alphaDir)).toEqual([target.slice(0, 12)]);
    const window = m.windowCommits(alphaDir, pinned.action_window_from_sha, pinned.commit_sha);
    expect(window.map((c) => c.subject)).toEqual(['fix: again', 'feat: more', 'test: core', 'feat: core']);
    expect(window.find((c) => c.sha === target)!.files).toEqual(['src/more.ts']);
    // And the checkout is REFUSED by name — a pin must be derivable from the immutable history alone.
    const c = run('check');
    expect(c.status).toBe(1);
    expect(c.stdout).toContain(
      `DRIFT     alpha — replace-refs-present: the checkout carries 1 git replacement ref(s) (refs/replace/ for ${target.slice(0, 12)}) — a replacement rewrites what a window commit says without moving any tag or count; a pin must be derivable from the immutable history alone: git replace -d <sha> (or use a clean clone) and retry`,
    );
    expect(c.stdout).toMatch(/ok\s+beta/);
    expect(c.stderr).toMatch(/FAIL — 1 drifted repo\(s\): alpha$/m);
    const s = run('samples', join(fixture, 'out-replaced'));
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/refusing to derive from the wrong history:\n\s+DRIFT\s+alpha — replace-refs-present: the checkout carries 1 git replacement ref\(s\)/);
    expect(existsSync(join(fixture, 'out-replaced', 'samples.json'))).toBe(false);
    // `pin` refuses too (exit 2 — a usage error, like a shallow source).
    const p = run('pin');
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/alpha: refusing to pin from a checkout carrying 1 git replacement ref\(s\) \(refs\/replace\/ for [0-9a-f]{12}\) — a pin must be derivable from the immutable history alone/);
    // The ref deleted: `check` passes and the derivation is byte-identical to the pre-replace run.
    git(alphaDir, 'replace', '-d', target);
    expect(m.replaceRefs(alphaDir)).toEqual([]);
    const clean = run('check');
    expect(clean.status, clean.stderr).toBe(0);
    expect(run('samples', outDir).status).toBe(0);
    expect(readFileSync(join(outDir, 'samples.json'), 'utf8')).toBe(before);
  });
});

describe('samples — one EvalSample per window commit', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  }, HOOK_TIMEOUT);

  it('derives every window commit as a sample the REAL crew EvalSampleSchema accepts, newest first per repo', () => {
    const s = run('samples', outDir);
    expect(s.status, s.stderr).toBe(0);
    const { samples, meta } = readSamples();
    // The strict zod schema (packages/crew/src/api/testing.ts ImportEvalCorpusSchema → EvalSampleSchema).
    const parsed = ImportEvalCorpusSchema.safeParse({ name: 'fixture', samples });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    // alpha 4 + beta 1 + gamma 1 = 6, in pin (codepoint) repo order, newest first inside a repo.
    expect(samples).toHaveLength(6);
    expect(meta.total).toBe(6);
    expect(meta.windows).toEqual([
      { repo: 'alpha', from: 'v0.1.0', tag: 'v0.3.0', commits: 4 },
      { repo: 'beta', from: 'v0.1.0', tag: 'v0.2.0', commits: 1 },
      { repo: 'gamma', from: 'v0.2.0', tag: 'v0.3.0', commits: 1 },
    ]);
    const alphaHead = git(join(sourceRoot, 'alpha'), 'rev-parse', 'HEAD');
    expect(samples[0]!.id).toBe(`alpha@${alphaHead.slice(0, 12)}`);
    for (const sample of samples) expect(sample.id).toMatch(/^(alpha|beta|gamma)@[0-9a-f]{12}$/);
    // Every commit here is a released one → good; content = subject + body; files = touched paths.
    expect(samples.every((x) => x.kind === 'good')).toBe(true);
    const more = samples.find((x) => x.description === 'feat: more')!;
    expect(more.signals).toEqual({ files: ['src/more.ts'], content: 'feat: more\n\nA body line.' });
    const again = samples.find((x) => x.description === 'fix: again')!;
    expect(again.signals.content).toBe('fix: again'); // no body → subject alone, no dangling separator
    // The window is `from..tag`: the from-tag's own commit (init) is NOT a sample.
    expect(samples.some((x) => x.description === 'init')).toBe(false);
  });

  it('infers steering_type from the explicit path table — a strict majority, else development', async () => {
    expect(run('samples', outDir).status).toBe(0);
    const { samples, meta } = readSamples();
    const byDesc = (d: string) => samples.find((x) => x.description === d)!;
    expect(byDesc('test: core').steering_type).toBe('testing'); // tests/core.test.ts
    expect(byDesc('feat: core').steering_type).toBe('development'); // src/core.ts — unclassified
    expect(byDesc('docs: readme').steering_type).toBe('development'); // docs are NOT design-ux/compliance
    expect(meta.steering_types).toEqual({ development: 5, testing: 1 });
    const m = await mod();
    expect(m.classifyPath('packages/crew/tests/x.test.ts')).toBe('testing');
    expect(m.classifyPath('.github/workflows/ci.yml')).toBe('operations');
    expect(m.classifyPath('src/auth/token.ts')).toBe('security');
    expect(m.classifyPath('LICENSE')).toBe('compliance');
    expect(m.classifyPath('.product/DES-EXEC-001.md')).toBe('architecture');
    expect(m.classifyPath('src/components/Button.tsx')).toBe('design-ux');
    expect(m.classifyPath('docs/guide.md')).toBeNull();
    expect(m.classifyPath('site/src/pages/index.astro')).toBeNull();
    // Majority: 2 of 3 testing → testing; 1 of 2 → development (a tie is "unsure"); none → development.
    expect(m.inferSteeringType(['tests/a.test.ts', 'tests/b.test.ts', 'src/c.ts'])).toBe('testing');
    expect(m.inferSteeringType(['tests/a.test.ts', 'src/c.ts'])).toBe('development');
    expect(m.inferSteeringType([])).toBe('development');
    expect(m.STEERING_TYPES).toContain('design-ux');
  });

  it('honors the known-bad allowlist (kind, reason, steering_type override) and fails closed on a stale id', () => {
    const alphaHead = git(join(sourceRoot, 'alpha'), 'rev-parse', 'HEAD');
    const badId = `alpha@${alphaHead.slice(0, 12)}`;
    writeFileSync(
      knownBadPath,
      JSON.stringify({ samples: { [badId]: { reason: 'force-pushed over a review', steering_type: 'security' } } }),
      'utf8',
    );
    const s = run('samples', outDir);
    expect(s.status, s.stderr).toBe(0);
    const { samples, meta } = readSamples();
    const bad = samples.find((x) => x.id === badId)!;
    expect(bad.kind).toBe('bad');
    expect(bad.description).toBe('fix: again — marked bad: force-pushed over a review');
    expect(bad.steering_type).toBe('security');
    expect(samples.filter((x) => x.kind === 'bad')).toHaveLength(1);
    expect(meta.bad).toBe(1);
    expect(ImportEvalCorpusSchema.safeParse({ name: 'fixture', samples }).success).toBe(true);

    // A stale entry (an id in no pinned window) is a drift signal, not something to skip quietly.
    writeFileSync(knownBadPath, JSON.stringify({ samples: { 'alpha@000000000000': { reason: 'gone' } } }), 'utf8');
    const stale = run('samples', outDir);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/known-bad names 1 id\(s\) not in any pinned window .*: alpha@000000000000/);

    // A malformed entry is a usage error.
    writeFileSync(knownBadPath, JSON.stringify({ samples: { [badId]: { reason: 'x', steering_type: 'vibes' } } }), 'utf8');
    const malformed = run('samples', outDir);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toMatch(/steering_type "vibes" is not one of/);
  });

  it('is deterministic (same bytes twice), stamps the identities, and refuses a drifted source', async () => {
    expect(run('samples', outDir).status).toBe(0);
    const first = readFileSync(join(outDir, 'samples.json'), 'utf8');
    const { samples, meta } = readSamples();
    expect(run('samples', outDir).status).toBe(0);
    expect(readFileSync(join(outDir, 'samples.json'), 'utf8')).toBe(first);
    const m = await mod();
    expect(meta.pin_hash).toBe(readPin().pin_hash);
    expect(meta.samples_hash).toBe(m.samplesHash(samples));
    expect(meta.samples_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta.corpus_name).toBe(m.corpusName(meta.pin_hash));
    expect(meta.corpus_name).toMatch(/^evals:wicked-internal@[0-9a-f]{16}$/);
    // Move a tag: the derivation must refuse rather than emit samples from the wrong history.
    moveTag('alpha', 'v0.3.0');
    const drifted = run('samples', join(fixture, 'out2'));
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toMatch(/source checkouts do not match the pin — refusing to derive/);
    expect(drifted.stderr).toMatch(/DRIFT\s+alpha — tag: v0\.3\.0/);
    expect(existsSync(join(fixture, 'out2', 'samples.json'))).toBe(false);
  });

  it('S15c: a missing, unreadable or malformed known-bad file is a usage error (exit 2) — never an empty allowlist', () => {
    // Missing (a misspelled --known-bad path must not silently relabel every bad commit good).
    rmSync(knownBadPath);
    const missing = run('samples', outDir);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/no known-bad file at .*known-bad\.json \(pass --known-bad <file>; an EMPTY allowlist is \{"samples": \{\}\}/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
    // Not JSON.
    writeFileSync(knownBadPath, '{ not json', 'utf8');
    const malformed = run('samples', outDir);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toMatch(/known-bad\.json is not valid JSON/);
    // No `samples` key / null / an array — the allowlist is a MAP keyed by sample id.
    for (const shape of [{ description: 'no samples key' }, { samples: null }, { samples: [] }, { samples: 'x' }]) {
      writeFileSync(knownBadPath, JSON.stringify(shape), 'utf8');
      const bad = run('samples', outDir);
      expect(bad.status, JSON.stringify(shape)).toBe(2);
      expect(bad.stderr, JSON.stringify(shape)).toMatch(/"samples" must be an object keyed by sample id/);
    }
    // Not an object at all.
    writeFileSync(knownBadPath, '[]', 'utf8');
    expect(run('samples', outDir).stderr).toMatch(/must be an object with a "samples" map/);
    // Unreadable (a directory at the path).
    rmSync(knownBadPath);
    mkdirSync(knownBadPath);
    const unreadable = run('samples', outDir);
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toMatch(/could not read known-bad file/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
  });

  it('S15d: derives byte-identical samples under two different operator git configurations — rename, order, quoting and encoding knobs are pinned', async () => {
    writeConstants({ delta: 'v0.2.0' });
    expect(run('pin').status).toBe(0);
    const plain = runEnv({ GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }, 'samples', outDir);
    expect(plain.status, plain.stderr).toBe(0);
    const plainBytes = readFileSync(join(outDir, 'samples.json'), 'utf8');
    const { samples, meta } = readSamples();
    const out2 = join(fixture, 'out-adversarial');
    const adversarial = runEnv({ GIT_CONFIG_GLOBAL: adversarialGitconfig }, 'samples', out2);
    expect(adversarial.status, adversarial.stderr).toBe(0);
    expect(readFileSync(join(out2, 'samples.json'), 'utf8')).toBe(plainBytes);
    expect((JSON.parse(readFileSync(join(out2, 'samples.meta.json'), 'utf8')) as SamplesMeta).samples_hash).toBe(meta.samples_hash);

    // The pinned semantics themselves — what BOTH derivations produced:
    const byDesc = (d: string) => samples.find((x) => x.description === d)!;
    expect(byDesc('refactor: rename init').signals.files).toEqual(['init.txt', 'moved.txt']); // a rename touches BOTH paths — no similarity heuristic
    expect(byDesc('feat: two files').signals.files).toEqual(['alpha.ts', 'zeta.ts']); // tree order, never an operator's diff.orderFile
    expect(byDesc('docs: naïve ünïcode').signals.files).toEqual(['docs/ünïcode.md']); // verbatim, never quoted + octal-escaped
    expect(byDesc('docs: naïve ünïcode').signals.content).toBe('docs: naïve ünïcode'); // UTF-8, never re-encoded

    // Control: the adversarial config DOES change an unpinned extraction (else this proves nothing).
    // `env` spreads process.env (the hermetic arming); re-stated so the harness-hygiene scan sees it.
    const unpinned = execFileSync('git', ['log', '--format=%s', '--name-only', 'v0.1.0..v0.2.0'], {
      cwd: join(sourceRoot, 'delta'),
      env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: adversarialGitconfig },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(unpinned).not.toContain('init.txt'); // rename detection collapsed the rename to its new path
    expect(unpinned.indexOf('zeta.ts')).toBeLessThan(unpinned.indexOf('alpha.ts')); // the order file reordered
    expect(unpinned).toContain('"docs/\\303\\274n\\303\\257code.md"'); // quotePath escaped the path
    expect(unpinned).not.toContain('docs: naïve ünïcode'); // the subject came back re-encoded
    // And the pin list is the documented one, so a knob cannot be dropped silently.
    const m = await mod();
    expect([...m.GIT_LOG_CONFIG]).toEqual([
      'core.quotePath=false',
      'diff.renames=false',
      'diff.relative=false',
      'diff.mnemonicPrefix=false',
      'diff.noprefix=false',
      'log.showSignature=false',
      'log.follow=false',
      'i18n.logOutputEncoding=UTF-8',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'S15h: filenames with leading/trailing spaces, a tab, a backslash, a quote and a newline round-trip EXACTLY into signals.files (NUL-delimited, never trimmed) — and the steering-type inference sees the real path',
    async () => {
      writeConstants({ epsilon: 'v0.2.0' });
      expect(run('pin').status).toBe(0);
      const s = run('samples', outDir);
      expect(s.status, s.stderr).toBe(0);
      const { samples } = readSamples();
      const byDesc = (d: string) => samples.find((x) => x.description === d)!;
      // Tree order, every byte verbatim.
      expect(byDesc('feat: adversarial names').signals.files).toEqual(['"quoted".txt', 'back\\slash.txt', 'new\nline.txt', 'tab\there.txt', 'trail.txt ']);
      const lead = byDesc('feat: leading-space dir');
      expect(lead.signals.files).toEqual([' tests/lead.ts']);
      // The REAL directory is " tests", not "tests": development. A trimmed path would say testing.
      expect(lead.steering_type).toBe('development');
      const m = await mod();
      expect(m.inferSteeringType(['tests/lead.ts'])).toBe('testing'); // what trimming would have produced
      expect(m.inferSteeringType([' tests/lead.ts'])).toBe('development');
      // The real route schema accepts them — they are plain strings.
      expect(ImportEvalCorpusSchema.safeParse({ name: 'fixture', samples }).success).toBe(true);
      // Control: WITHOUT -z, git C-quotes these names even under core.quotePath=false — the escapes
      // the old newline-split extraction kept as literal filenames.
      const quoted = execFileSync('git', ['-c', 'core.quotePath=false', 'log', '--format=%s', '--name-only', 'v0.1.0..v0.2.0'], {
        cwd: join(sourceRoot, 'epsilon'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      expect(quoted).toContain('"tab\\there.txt"');
      expect(quoted).toContain('"new\\nline.txt"');
      expect(quoted).toContain('"back\\\\slash.txt"');
      // The `-z` grammar is asserted, never assumed.
      expect(m.parseNulPaths('\0', 'c', 's')).toEqual([]);
      expect(m.parseNulPaths('\0\n a\0b \0', 'c', 's')).toEqual([' a', 'b ']);
      expect(() => m.parseNulPaths('\n a\0', 'c', 's')).toThrow(/expected a NUL after the header/);
      expect(() => m.parseNulPaths('\0\na', 'c', 's')).toThrow(/NUL-terminated/);
      expect(() => m.parseNulPaths('\0a\0', 'c', 's')).toThrow(/expected a newline before the path list/);
    },
  );

  it("S15l: each window's derived commit count is checked against the pin's `commits` — a count `pin_hash` does not cover, hand-edited, is refused by name; a `.git/shallow` graft INSIDE the window (both tags resolve, fewer commits) is refused as shallow before derivation", async () => {
    const m = await mod();
    const pin = readPin();
    const alpha = pinOf(pin, 'alpha');
    expect(alpha.commits).toBe(4);
    alpha.commits = 99;
    // The hash is over the (repo, tag, sha, from tag, from sha) tuples — the count is DERIVED, not identity, and git says what it really is.
    expect(m.pinHash(pin.repos)).toBe(pin.pin_hash);
    writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
    const edited = run('samples', outDir);
    expect(edited.status).toBe(1);
    expect(edited.stderr).toMatch(/alpha: the window v0\.1\.0\.\.v0\.3\.0 derived 4 commit\(s\) but the pin records 99 — the checkout does not hold the pinned history/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
    // A pin without the count at all is a constants-only file: usage error, run `pin`.
    delete (alpha as Partial<PinRepo>).commits;
    writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
    const uncounted = run('samples', outDir);
    expect(uncounted.status).toBe(2);
    expect(uncounted.stderr).toMatch(/alpha records no window commit count \(`commits`\) — run `pin` first/);
    // Restore the pin, then graft the history: `.git/shallow` naming v0.3.0~1 cuts the window to 2 of
    // its 4 commits while both tags still resolve (codex's "in-memory shallow-boundary override", on disk).
    expect(run('pin').status).toBe(0);
    const alphaDir = join(sourceRoot, 'alpha');
    writeFileSync(join(alphaDir, '.git', 'shallow'), `${git(alphaDir, 'rev-parse', 'v0.3.0~1')}\n`, 'utf8');
    expect(git(alphaDir, 'rev-list', '--count', 'v0.1.0..v0.3.0')).toBe('2');
    expect(git(alphaDir, 'rev-parse', 'v0.1.0^{commit}')).toBe(pinOf(readPin(), 'alpha').action_window_from_sha);
    expect(m.shallowEvidence(alphaDir)).toEqual(['`git rev-parse --is-shallow-repository` says true', `${join(alphaDir, '.git', 'shallow')} exists`]);
    const grafted = run('samples', outDir);
    expect(grafted.status).toBe(1);
    expect(grafted.stderr).toMatch(/DRIFT\s+alpha — shallow: the checkout has INCOMPLETE history/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
    // Ungrafted: the full history derives exactly the pin's counts.
    rmSync(join(alphaDir, '.git', 'shallow'));
    expect(m.shallowEvidence(alphaDir)).toEqual([]);
    expect(run('samples', outDir).status).toBe(0);
    expect(readSamples().meta.windows.find((w) => w.repo === 'alpha')!.commits).toBe(4);
  });

  it('S15k: validateSample IS the route schema — signals.phase/tool of the wrong type are refused exactly as POST /testing/corpora/import refuses them (no mirror)', async () => {
    const m = await mod();
    const bad = { id: 'x@000000000000', description: 'd', kind: 'good', steering_type: 'development', signals: { phase: 123, tool: [] } };
    expect(m.validateSample(bad)).toEqual(['signals.phase: Expected string, received number', 'signals.tool: Expected string, received array']);
    const route = ImportEvalCorpusSchema.safeParse({ name: 'x', samples: [bad] });
    expect(route.success).toBe(false);
    expect(route.success ? [] : route.error.issues.map((i) => i.path.slice(2).join('.'))).toEqual(['signals.phase', 'signals.tool']);
    expect(m.validateSample({ ...bad, signals: { phase: 'build', tool: 'Bash' } })).toEqual([]);
    expect(m.validateSample({ ...bad, signals: {}, extra: 1 })).toEqual(["(sample): Unrecognized key(s) in object: 'extra'"]);
    expect(m.validateSample({ ...bad, signals: { bogus: 1 } })).toEqual(["signals: Unrecognized key(s) in object: 'bogus'"]);
    // The engine's vocabulary rides on top of the route schema (which leaves steering_type open).
    expect(m.validateSample({ ...bad, signals: {}, steering_type: 'vibes' })).toEqual([
      'steering_type: "vibes" is not one of architecture|development|security|testing|operations|compliance|design-ux',
    ]);
    expect(m.validateSample(null)).toEqual(['(sample): Expected object, received null']);
  });
});

describe('materialize — git archive of each pinned tag', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  }, HOOK_TIMEOUT);

  it('extracts <dir>/<repo>@<tag>/ trees at the pinned commit and writes a receipt', () => {
    // A commit AFTER the pinned tag must not be in the archive.
    commitFile(join(sourceRoot, 'alpha'), 'after-tag.txt', 'feat: after the tag', 9);
    const m = run('materialize', outDir);
    expect(m.status, m.stderr).toBe(0);
    for (const dir of ['alpha@v0.3.0', 'beta@v0.2.0', 'gamma@v0.3.0']) expect(existsSync(join(outDir, dir, 'init.txt'))).toBe(true);
    expect(existsSync(join(outDir, 'alpha@v0.3.0', 'src', 'again.ts'))).toBe(true);
    expect(existsSync(join(outDir, 'alpha@v0.3.0', 'after-tag.txt'))).toBe(false);
    expect(existsSync(join(outDir, 'alpha@v0.3.0.tar'))).toBe(false); // the tar is transient
    const receipt = JSON.parse(readFileSync(join(outDir, 'materialized.json'), 'utf8')) as { pin_hash: string; repos: { repo: string; commit_sha: string }[] };
    expect(receipt.pin_hash).toBe(readPin().pin_hash);
    expect(receipt.repos.map((r) => r.repo)).toEqual(['alpha', 'beta', 'gamma']);
    expect(receipt.repos[0]!.commit_sha).toBe(pinOf(readPin(), 'alpha').commit_sha);
  });

  it('refuses (exit 1, nothing extracted) when ANY pinned sha no longer matches the checkout', () => {
    moveTag('beta', 'v0.2.0');
    const m = run('materialize', outDir);
    expect(m.status).toBe(1);
    expect(m.stderr).toMatch(/refusing to derive from the wrong history/);
    expect(m.stderr).toMatch(/DRIFT\s+beta — tag: v0\.2\.0/);
    expect(existsSync(join(outDir, 'alpha@v0.3.0'))).toBe(false);
    expect(existsSync(join(outDir, 'materialized.json'))).toBe(false);
  });

  it('S15e: a pinned repo that is not ONE safe path segment is rejected at read time (exit 2) — before any fs operation, in every mode', async () => {
    const m = await mod();
    expect(m.isSafeSegment('wicked-crew')).toBe(true);
    expect(m.isSafeSegment('a.b_c-d')).toBe(true);
    for (const bad of ['../escape', '..', '.', 'a/b', 'a\\b', '/abs', 'a b', 'a\0b', '']) expect(m.isSafeSegment(bad), JSON.stringify(bad)).toBe(false);

    // A hash-valid pin whose repo traverses: `<outDir>/../escape@v0.3.0` = the sentinel below.
    const pin = readPin();
    const alpha = pinOf(pin, 'alpha');
    alpha.repo = '../escape';
    pin.pin_hash = m.pinHash(pin.repos);
    writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
    const sentinel = join(fixture, 'escape@v0.3.0');
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(join(sentinel, 'keep.txt'), 'must survive', 'utf8');
    const matDir = join(fixture, 'mat');
    for (const mode of ['materialize', 'samples'] as const) {
      const r = run(mode, matDir);
      expect(r.status, mode).toBe(2);
      expect(r.stderr, mode).toMatch(/repo "\.\.\/escape" is not a single safe path segment/);
    }
    expect(run('check').status).toBe(2);
    expect(readFileSync(join(sentinel, 'keep.txt'), 'utf8')).toBe('must survive');
    expect(existsSync(matDir)).toBe(false); // nothing was created either
    for (const shape of ['/abs', 'a/b', 'a\\b', '.', '..']) {
      alpha.repo = shape;
      pin.pin_hash = m.pinHash(pin.repos);
      writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
      const r = run('check');
      expect(r.status, shape).toBe(2);
      expect(r.stderr, shape).toMatch(/is not a single safe path segment/);
    }
  });

  it('S15f: refuses (exit 1) to remove or extract through a symlinked <repo>@<tag> entry — the link target survives, nothing else is extracted', () => {
    const target = join(fixture, 'elsewhere');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'precious.txt'), 'x', 'utf8');
    mkdirSync(outDir, { recursive: true });
    symlinkSync(target, join(outDir, 'alpha@v0.3.0'));
    const m = run('materialize', outDir);
    expect(m.status).toBe(1);
    expect(m.stderr).toMatch(/refusing to materialize into .*alpha@v0\.3\.0: it is a symlink/);
    expect(existsSync(join(target, 'precious.txt'))).toBe(true);
    expect(lstatSync(join(outDir, 'alpha@v0.3.0')).isSymbolicLink()).toBe(true); // untouched
    expect(existsSync(join(outDir, 'beta@v0.2.0'))).toBe(false); // alpha sorts first: the refusal stopped everything
    expect(existsSync(join(outDir, 'materialized.json'))).toBe(false);
    expect(readdirSync(outDir)).toEqual(['alpha@v0.3.0']); // no transient tar beside the destination either
  });

  it('a materialize ROOT reached through a symlink is the operator\'s choice: containment is judged against its realpath', () => {
    const real = join(fixture, 'real-root');
    mkdirSync(real, { recursive: true });
    const link = join(fixture, 'link-root');
    symlinkSync(real, link);
    const m = run('materialize', link);
    expect(m.status, m.stderr).toBe(0);
    expect(existsSync(join(real, 'alpha@v0.3.0', 'init.txt'))).toBe(true);
    const receipt = JSON.parse(readFileSync(join(real, 'materialized.json'), 'utf8')) as { repos: { path: string }[] };
    // Paths in the receipt are under the ROOT's realpath (macOS tmpdir is itself /var → /private/var).
    for (const r of receipt.repos) expect(r.path.startsWith(`${realpathSync(real)}/`)).toBe(true);
    expect(readdirSync(real).filter((f) => f.endsWith('.tmp') || f.endsWith('.tar'))).toEqual([]);
  });

  it("S15i: the extracted tree is independent of the operator's git attributes — a core.attributesFile export-ignore changes an unpinned archive but not the materialization; the receipt carries each tree sha", () => {
    const plain = runEnv({ GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }, 'materialize', outDir);
    expect(plain.status, plain.stderr).toBe(0);
    const hostile = runEnv({ GIT_CONFIG_GLOBAL: attributesGitconfig }, 'materialize', join(fixture, 'out-attrs'));
    expect(hostile.status, hostile.stderr).toBe(0);
    for (const repo of ['alpha@v0.3.0', 'beta@v0.2.0', 'gamma@v0.3.0']) {
      expect(treeIdentity(join(fixture, 'out-attrs', repo)), repo).toBe(treeIdentity(join(outDir, repo)));
    }
    expect(existsSync(join(fixture, 'out-attrs', 'beta@v0.2.0', 'README.md'))).toBe(true); // the export-ignored file survived
    const receipt = JSON.parse(readFileSync(join(outDir, 'materialized.json'), 'utf8')) as {
      attributes: { pinned: string[]; verified: string };
      repos: { repo: string; tree_sha: string; entries: number }[];
    };
    const beta = receipt.repos.find((r) => r.repo === 'beta')!;
    expect(beta.tree_sha).toBe(git(join(sourceRoot, 'beta'), 'rev-parse', 'v0.2.0^{tree}'));
    expect(beta.entries).toBe(2); // init.txt + README.md
    expect(receipt.attributes.pinned).toEqual(['core.attributesFile=<empty file>', 'GIT_ATTR_NOSYSTEM=1', 'no --worktree-attributes']);
    expect(receipt.attributes.verified).toContain('ls-tree');
    // Control: an UNPINNED archive under the same config DROPS README.md (else this proves nothing).
    // `env` spreads process.env (the hermetic arming); re-stated so the harness-hygiene scan sees it.
    const unpinned = execFileSync('sh', ['-c', 'git archive --format=tar v0.2.0 | tar -t'], {
      cwd: join(sourceRoot, 'beta'),
      env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: attributesGitconfig },
      encoding: 'utf8',
    });
    expect(unpinned).toContain('init.txt');
    expect(unpinned).not.toContain('README.md');
  });

  it('S15j: an export-ignore from a source git offers NO override for ($GIT_DIR/info/attributes) is a named refusal (exit 1) — never a different tree recorded as the pin', () => {
    mkdirSync(join(sourceRoot, 'beta', '.git', 'info'), { recursive: true });
    writeFileSync(join(sourceRoot, 'beta', '.git', 'info', 'attributes'), 'README.md export-ignore\n', 'utf8');
    const m = run('materialize', outDir);
    expect(m.status).toBe(1);
    expect(m.stderr).toMatch(/refusing to accept the materialized beta@v0\.2\.0: the extracted tree is not the committed tree [0-9a-f]{40}\n\s+missing \(1\): "README\.md"/);
    expect(m.stderr).toMatch(/info\/attributes or in the commit's own \.gitattributes cannot be overridden/);
    expect(existsSync(join(outDir, 'materialized.json'))).toBe(false); // no receipt
    // alpha (sorted first) HAD verified — into its staging dir, which the failure removed: nothing
    // is swapped into place until EVERY repo verifies.
    expect(existsSync(join(outDir, 'alpha@v0.3.0'))).toBe(false);
    expect(readdirSync(outDir)).toEqual([]); // no staging, no .prev, no lock
  });

  it('S15m: a FAILED repeat leaves the previous trees AND receipt byte-intact (every repo is extracted + verified into a staging dir beside its destination; the swap happens only after ALL verified); a failed FIRST run leaves no receipt and no debris; a receipt beside a missing tree is removed', () => {
    const first = run('materialize', outDir);
    expect(first.status, first.stderr).toBe(0);
    const trees = ['alpha@v0.3.0', 'beta@v0.2.0', 'gamma@v0.3.0'];
    const before = Object.fromEntries(trees.map((t) => [t, treeIdentity(join(outDir, t))]));
    const receiptBefore = readFileSync(join(outDir, 'materialized.json'), 'utf8');
    const receipt = JSON.parse(receiptBefore) as { generation: string; repos: { path: string }[] };
    expect(receipt.generation).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(first.stdout).toContain(`generation ${receipt.generation}`);
    expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']);
    // Damage a source so the SECOND repo fails verification (beta sorts after alpha, so alpha has
    // already been extracted + verified — into staging, never into place).
    mkdirSync(join(sourceRoot, 'beta', '.git', 'info'), { recursive: true });
    writeFileSync(join(sourceRoot, 'beta', '.git', 'info', 'attributes'), 'README.md export-ignore\n', 'utf8');
    const failed = run('materialize', outDir);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/refusing to accept the materialized beta@v0\.2\.0/);
    for (const t of trees) expect(treeIdentity(join(outDir, t)), t).toBe(before[t]);
    expect(readFileSync(join(outDir, 'materialized.json'), 'utf8')).toBe(receiptBefore); // still describes exactly what is there
    expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']); // no .staging-*, no .prev-*, no lock
    // A receipt beside a tree that is no longer there does not survive a failure — it described output that does not exist.
    rmSync(join(outDir, 'alpha@v0.3.0'), { recursive: true, force: true });
    expect(run('materialize', outDir).status).toBe(1);
    expect(existsSync(join(outDir, 'materialized.json'))).toBe(false);
    expect(readdirSync(outDir).sort()).toEqual(['beta@v0.2.0', 'gamma@v0.3.0']);
    // A failed FIRST run: no receipt, no staging debris — an empty root.
    const fresh = join(fixture, 'fresh');
    expect(run('materialize', fresh).status).toBe(1);
    expect(readdirSync(fresh)).toEqual([]);
    // Repaired source ⇒ the repeat succeeds and swaps the trees in under a new generation.
    rmSync(join(sourceRoot, 'beta', '.git', 'info', 'attributes'));
    const repaired = run('materialize', outDir);
    expect(repaired.status, repaired.stderr).toBe(0);
    for (const t of trees) expect(treeIdentity(join(outDir, t)), t).toBe(before[t]);
    const after = JSON.parse(readFileSync(join(outDir, 'materialized.json'), 'utf8')) as { generation: string };
    expect(after.generation).not.toBe(receipt.generation);
    expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']);
  });

  it('S15o: every `.prev` backup is kept until the receipt is published — a fault at the SECOND staging rename or at the receipt write is rolled back (every destination byte-identical to before, the previous receipt untouched, no debris); on a fresh root the same faults leave an empty root; a fault in the rollback itself removes the receipt and names BOTH faults; the hook is inert outside the test env', async () => {
    const m = await mod();
    expect(m.FAULT_ENV).toBe('EVALS_CORPUS_FAULT');
    const trees = ['alpha@v0.3.0', 'beta@v0.2.0', 'gamma@v0.3.0'];
    const first = run('materialize', outDir);
    expect(first.status, first.stderr).toBe(0);
    // Markers planted in the PREVIOUS trees: a successful repeat replaces them (the committed tree has
    // no marker), so a marker that survives proves the destination is the RESTORED previous tree, not
    // a new one that happens to be byte-identical.
    for (const t of trees) writeFileSync(join(outDir, t, 'previous-marker.txt'), t, 'utf8');
    const before = Object.fromEntries(trees.map((t) => [t, treeIdentity(join(outDir, t))]));
    const receiptBefore = readFileSync(join(outDir, 'materialized.json'), 'utf8');
    const faultAt = (points: string, dir = outDir) => runEnv({ [m.FAULT_ENV]: points }, 'materialize', dir);
    // (a) The SECOND repo's staging → destination rename fails (codex's injection point): alpha
    // (first) was already swapped in, beta's destination already moved to .prev, gamma untouched.
    const swap2 = faultAt('swap:2');
    expect(swap2.status).toBe(2); // an IO error, like the fs failure it stands in for
    expect(swap2.stderr).toMatch(/injected fault at swap:2 \(EVALS_CORPUS_FAULT, test hook\)/);
    expect(swap2.stderr).not.toMatch(/rollback failed/);
    for (const t of trees) {
      expect(treeIdentity(join(outDir, t)), t).toBe(before[t]);
      expect(readFileSync(join(outDir, t, 'previous-marker.txt'), 'utf8'), t).toBe(t);
    }
    expect(readFileSync(join(outDir, 'materialized.json'), 'utf8')).toBe(receiptBefore);
    expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']); // no .staging-*, .prev-*, .tmp, lock
    // (b) The receipt write fails AFTER every swap: all three destinations restored, receipt untouched.
    const receipt = faultAt('receipt');
    expect(receipt.status).toBe(2);
    expect(receipt.stderr).toMatch(/injected fault at receipt \(EVALS_CORPUS_FAULT, test hook\)/);
    for (const t of trees) {
      expect(treeIdentity(join(outDir, t)), t).toBe(before[t]);
      expect(existsSync(join(outDir, t, 'previous-marker.txt')), t).toBe(true);
    }
    expect(readFileSync(join(outDir, 'materialized.json'), 'utf8')).toBe(receiptBefore);
    expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']);
    // (c) A FIRST run (no previous trees, no receipt) under the same faults: an empty root — never
    // a partial tree, never a receipt.
    for (const point of ['swap:2', 'receipt']) {
      const fresh = join(fixture, `fresh-${point.replace(':', '-')}`);
      const r = faultAt(point, fresh);
      expect(r.status, point).toBe(2);
      expect(readdirSync(fresh), point).toEqual([]);
    }
    // (d) The DOUBLE fault: the swap fails AND the rollback fails — the receipt is removed (nothing
    // may describe a damaged tree), exit 1, and the error names both faults + the debris left behind.
    const double = faultAt('swap:2,rollback');
    expect(double.status).toBe(1);
    expect(double.stderr).toMatch(
      /materialize failed while swapping the verified trees into .* \(injected fault at swap:2 \(EVALS_CORPUS_FAULT, test hook\)\) AND the rollback failed \(injected fault at rollback \(EVALS_CORPUS_FAULT, test hook\)\) — the trees there may be damaged: the receipt was removed so nothing describes them; inspect the \.staging-\d{8}-\d{6}-[0-9a-f]{8} \/ \.prev-\d{8}-\d{6}-[0-9a-f]{8} entries by hand before re-running/,
    );
    expect(existsSync(join(outDir, 'materialized.json'))).toBe(false);
    expect(existsSync(join(outDir, 'beta@v0.2.0'))).toBe(false); // the damage the rollback would have undone
    expect(readdirSync(outDir).some((f) => f.startsWith('.beta@v0.2.0.prev-'))).toBe(true); // its backup is still there for the operator
    expect(readdirSync(outDir).some((f) => f.endsWith('.lock'))).toBe(false); // the lock is always released
    // (e) The hook is INERT outside the test environment: the same variable with NODE_ENV not `test`
    // and VITEST not "true" ⇒ a normal, successful materialization that also repairs the root.
    const inert = runEnv({ [m.FAULT_ENV]: 'swap:1', NODE_ENV: 'production', VITEST: '' }, 'materialize', outDir);
    expect(inert.status, inert.stderr).toBe(0);
    for (const t of trees) expect(existsSync(join(outDir, t, 'previous-marker.txt')), t).toBe(false); // NEW trees — the committed ones
    const published = JSON.parse(readFileSync(join(outDir, 'materialized.json'), 'utf8')) as { repos: { repo: string; path: string; tree_sha: string }[] };
    expect(published.repos.map((r) => r.repo)).toEqual(['alpha', 'beta', 'gamma']);
    for (const r of published.repos) {
      expect(existsSync(r.path)).toBe(true);
      expect(r.tree_sha).toBe(git(join(sourceRoot, r.repo), 'rev-parse', `${pinOf(readPin(), r.repo).commit_sha}^{tree}`));
    }
  });

  it(
    'S15n: two CONCURRENT materializations into one root — each either publishes or is refused by `.materialize.lock` (never interleaved); the surviving trees are the committed trees, the receipt describes them, no staging/prev/lock debris',
    async () => {
      const spawnMaterialize = () =>
        new Promise<{ status: number | null; stderr: string }>((resolveRun) => {
          const args = [SCRIPT, 'materialize', outDir, '--pin', pinPath, '--source-root', sourceRoot, '--known-bad', knownBadPath];
          // `env` spreads process.env (the hermetic arming); re-stated for the harness-hygiene scan.
          const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          child.on('close', (status) => resolveRun({ status, stderr }));
        });
      const [x, y] = await Promise.all([spawnMaterialize(), spawnMaterialize()]);
      for (const r of [x, y]) {
        expect([0, 1]).toContain(r.status);
        if (r.status === 1) expect(r.stderr).toMatch(/another `materialize` publication holds .*\.materialize\.lock \(pid \d+ generation \d{8}-\d{6}-[0-9a-f]{8}\) — refusing to interleave/);
      }
      expect([x.status, y.status]).toContain(0); // at least one published
      const trees = ['alpha@v0.3.0', 'beta@v0.2.0', 'gamma@v0.3.0'];
      expect(readdirSync(outDir).sort()).toEqual([...trees, 'materialized.json']);
      // A reference materialization into another root: the surviving trees are byte-identical to it.
      const reference = join(fixture, 'reference');
      expect(run('materialize', reference).status).toBe(0);
      for (const t of trees) expect(treeIdentity(join(outDir, t)), t).toBe(treeIdentity(join(reference, t)));
      const receipt = JSON.parse(readFileSync(join(outDir, 'materialized.json'), 'utf8')) as { pin_hash: string; generation: string; repos: { repo: string; tree_sha: string; path: string }[] };
      expect(receipt.pin_hash).toBe(readPin().pin_hash);
      expect(receipt.repos.map((r) => r.repo)).toEqual(['alpha', 'beta', 'gamma']);
      for (const r of receipt.repos) {
        expect(existsSync(r.path)).toBe(true);
        expect(r.tree_sha).toBe(git(join(sourceRoot, r.repo), 'rev-parse', `${pinOf(readPin(), r.repo).commit_sha}^{tree}`));
      }
    },
    30_000,
  );
});

describe('run — ingest the doctrine seed, eval the samples (a fake engine CLI stands in)', () => {
  let fakeBin: string;
  let rulesDir: string;
  /** The engine binary name the script looks for — owned by the script, not spelled here. */
  let coreBin: string;

  beforeEach(async () => {
    expect(run('pin').status).toBe(0);
    expect(run('samples', outDir).status).toBe(0);
    fakeBin = join(fixture, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    rulesDir = join(fixture, 'seed');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'doctrine.md'), '---\nid: DOC-1\n---\n', 'utf8');
    coreBin = (await mod()).CORE_BIN;
  }, HOOK_TIMEOUT);

  /** An engine CLI on PATH that behaves per `script` (sh) — exercises the seams without the engine. */
  function fakeCore(script: string): void {
    const path = join(fakeBin, coreBin);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8');
    chmodSync(path, 0o755);
  }

  /** `run` with the fake bin dir FIRST on PATH (so the fake shadows any installed wicked-core; the
   *  fake's own `grep`/`printf` still resolve), or with PATH = the fake dir ALONE for the
   *  not-on-PATH case. */
  function runWithPath(path: 'fake-first' | 'fake-only' = 'fake-first', ...extra: string[]) {
    const args = [SCRIPT, 'run', outDir, '--pin', pinPath, '--source-root', sourceRoot, '--rules', rulesDir, ...extra];
    const PATH = path === 'fake-only' ? fakeBin : `${fakeBin}:${process.env['PATH'] ?? ''}`;
    // `env` already spreads process.env; re-stated so the harness-hygiene scan sees the arming here.
    const res = spawnSync(process.execPath, args, { env: { ...process.env, ...env, PATH }, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('SKIPs (exit 0, said so) when the engine CLI is not on PATH — nothing to run is not a failure', () => {
    const r = runWithPath('fake-only');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`run: SKIP — ${coreBin} is not on PATH`);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  it('a TOOL failure is exit 1 and names the failing step — gaps in a report never are', () => {
    fakeCore('case "$1 $2" in "rules ingest") echo "ingest: NO policies found" >&2; exit 1;; esac; echo "wicked-core 9.9.9-fake"');
    const r = runWithPath();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/run: TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — rules ingest failed \(exit 1\): ingest: NO policies found/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  /** The rules the fake engine "ingested" — what its `rules list --include-retired --json` lists
   *  back (the FULL rule, retired row included: plan §3's snapshot identity). */
  const FAKE_RULES = [
    { id: 'DOC-1', steering_type: 'architecture', effect: 'deny', trigger: { contains: ['force-push'] }, retired: false },
    { id: 'DOC-0', steering_type: 'development', effect: 'warn', retired: true },
  ];

  /** A fake engine that SUCCEEDS and behaves like the real loader: it evaluates EVERY *.json in the
   *  corpus dir it is handed (evals.rs `load_corpus` — the smuggling surface a shared dir opens),
   *  echoing one result row per sample as evals.rs would (a good sample `caught`, a bad one `gap`),
   *  answers `rules list --json` with FAKE_RULES, records the dir it received + its listing, and
   *  touches `engine-invoked` on every call. It also asserts the CONTRACT the real CLI has:
   *  `--corpus` is a directory (never a file); `--db` / `--knowledge-db` are TEMP paths (never the
   *  output dir or the operator's home). `rowsJs` replaces the row synthesis (a misbehaving engine);
   *  `summaryJs` the summary expression (a roll-up that is not the rows' tally); `ruleCoverage:
   *  false` drops `rule_coverage` (a pre-#394 engine); `coverageJs` / `degradedJs` replace the
   *  `, rule_coverage: …` / `, degraded: …` fragments verbatim (`''` omits the key — a malformed
   *  wire shape); `rulesList: 'usage'` answers `rules list` with the usage banner (an engine
   *  without the command). */
  function okEngine(opts: { rowsJs?: string; summaryJs?: string; ruleCoverage?: boolean; coverageJs?: string; degradedJs?: string; rulesList?: 'json' | 'usage' } = {}): void {
    const rowsJs =
      opts.rowsJs ??
      'const results = samples.map((x) => ({ sample: { id: x.id, description: x.description, kind: x.kind, steering_type: x.steering_type }, expected: x.kind === "bad" ? "deny" : "allow", fired: [], verdict: x.kind === "bad" ? "gap" : "caught" }));';
    const summaryJs = opts.summaryJs ?? '{ total: results.length, caught: count("caught"), gaps: count("gap"), false_positives: count("false_positive") }';
    const coverageJs = opts.coverageJs ?? (opts.ruleCoverage === false ? '' : ', rule_coverage: { exercised: 0, unexercised: [{ rule_id: "DOC-1", steering_type: "architecture" }] }');
    const degradedJs = opts.degradedJs ?? ', degraded: "facet-only"';
    // The eval branch is node (the fake shells out to the test's own node): sh cannot parse JSON.
    // Double quotes only — the program rides inside the shell's single quotes.
    const evalJs = [
      'const fs = require("fs"); const p = require("path"); const dir = process.argv[1];',
      'const samples = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(fs.readFileSync(p.join(dir, f), "utf8")));',
      rowsJs,
      'const count = (v) => results.filter((r) => r.verdict === v).length;',
      `process.stdout.write(JSON.stringify({ results, summary: ${summaryJs}${degradedJs}${coverageJs} }));`,
    ].join(' ');
    const rulesList =
      opts.rulesList === 'usage'
        ? '  "rules list") echo "usage: wicked-core <status | repos | run --problem ...> [--db <path>]"; exit 0;;'
        : `  "rules list") printf '%s' '${JSON.stringify({ count: FAKE_RULES.length, include_retired: true, rules: FAKE_RULES })}'; exit 0;;`;
    fakeCore(
      [
        `touch "${join(fixture, 'engine-invoked')}"`,
        'case "$1 $2" in',
        '  "rules ingest") [ -d "$3" ] || { echo "no seed dir" >&2; exit 1; }; exit 0;;',
        rulesList,
        '  "rules eval")',
        '    corpus=""; db=""; kdb="";',
        '    while [ $# -gt 0 ]; do case "$1" in --corpus) corpus="$2"; shift;; --db) db="$2"; shift;; --knowledge-db) kdb="$2"; shift;; esac; shift; done',
        '    [ -d "$corpus" ] || { echo "--corpus must be a DIRECTORY, got $corpus" >&2; exit 1; }',
        `    case "$db" in "${outDir}"*|"$HOME/.wicked"*) echo "db must be a temp path, got $db" >&2; exit 1;; esac`,
        `    case "$corpus" in "${outDir}"*) echo "corpus must be staged OUTSIDE the output dir, got $corpus" >&2; exit 1;; esac`,
        '    [ -n "$kdb" ] || { echo "no --knowledge-db" >&2; exit 1; }',
        `    printf '%s\\n' "$corpus" > "${join(fixture, 'corpus-dir.txt')}"`,
        `    ls -A "$corpus" > "${join(fixture, 'corpus-listing.txt')}"`,
        `    "${process.execPath}" -e '${evalJs}' "$corpus"`,
        '    exit $?;;',
        'esac',
        'echo "wicked-core 9.9.9-fake"',
      ].join('\n'),
    );
  }

  it("writes <dir>/report.json from the engine's JSON, stages EXACTLY the pinned samples in a fresh private corpus dir, stamps every row's payload_hash, publishes COMPLETE provenance bound to the report by content, prints summary + rule_coverage, exits 0 on gaps", async () => {
    okEngine();
    // The smuggling attempt the old shared `<dir>/corpus` allowed: an extra sample file already
    // sitting where the runner used to stage. The engine loads every *.json it is given — so the
    // staging dir must hold the pinned samples and NOTHING else.
    mkdirSync(join(outDir, 'corpus'), { recursive: true });
    writeFileSync(join(outDir, 'corpus', 'extra.json'), JSON.stringify([{ id: 'smuggled@000000000000', description: 'not pinned', kind: 'bad', steering_type: 'security', signals: {} }]), 'utf8');
    const r = runWithPath();
    expect(r.status, r.stderr).toBe(0);
    const reportText = readFileSync(join(outDir, 'report.json'), 'utf8');
    const report = JSON.parse(reportText) as Report;
    expect(report.summary).toEqual({ total: 6, caught: 6, gaps: 0, false_positives: 0 }); // 6 pinned, all good ⇒ caught — the smuggled one was never seen
    expect(report.rule_coverage!.unexercised).toEqual([{ rule_id: 'DOC-1', steering_type: 'architecture' }]);
    const corpusDir = readFileSync(join(fixture, 'corpus-dir.txt'), 'utf8').trim();
    expect(corpusDir.startsWith(outDir)).toBe(false); // a fresh private temp dir, not <dir>/corpus
    expect(existsSync(corpusDir)).toBe(false); // removed when the run ended
    expect(readFileSync(join(fixture, 'corpus-listing.txt'), 'utf8').trim().split('\n')).toEqual(['samples.json']); // exactly one file
    expect(existsSync(join(outDir, 'corpus', 'samples.json'))).toBe(false); // the shared location is no longer written
    expect(r.stdout).toContain('summary: total 6 · caught 6 · gaps 0 · false_positives 0 · degraded "facet-only"');
    expect(r.stdout).toContain('rule_coverage: exercised 0 · unexercised 1');
    expect(r.stdout).toContain('unexercised DOC-1 (architecture)');

    // Every result row names a staged sample and carries THAT sample's payload identity — the hash
    // `compareEvalRuns` keys comparability on (the engine echoes no signals; the runner held them).
    const { samples, meta } = readSamples();
    const byId = new Map(samples.map((s) => [s.id, s]));
    expect(report.results.map((row) => row.sample.id).sort()).toEqual(samples.map((s) => s.id).sort());
    for (const row of report.results) expect(row.sample.payload_hash, row.sample.id).toBe(samplePayloadHash(byId.get(row.sample.id)!));

    // The provenance sidecar: complete, and bound to THIS report by content (one generation).
    const rmeta = JSON.parse(readFileSync(join(outDir, 'report.meta.json'), 'utf8')) as ReportMeta;
    expect(rmeta.generation).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(report.generation).toBe(rmeta.generation);
    expect(rmeta.report_sha256).toBe(sha256(reportText));
    expect(rmeta.pin_hash).toBe(meta.pin_hash);
    expect(rmeta.samples_hash).toBe(meta.samples_hash);
    expect(rmeta.corpus_name).toBe(meta.corpus_name);
    expect(rmeta.samples_generation).toBe(meta.generation);
    // Engine: the version string AND the build identity — realpath + sha256 of the binary on PATH.
    const fake = join(fakeBin, coreBin);
    expect(rmeta.engine).toEqual({ version: 'wicked-core 9.9.9-fake', build: { path: realpathSync(fake), sha256: sha256(readFileSync(fake)) } });
    // Rule snapshot: the canonical hash of every rule the engine listed back from the temp store
    // (order-independent, content-bearing), with the method named; plus the seed dir's identity.
    const m = await mod();
    expect(rmeta.rules_identity).toEqual({ method: 'engine-list', command: expect.stringContaining('rules list'), sha256: m.rulesSnapshotHash(FAKE_RULES), rule_count: 2 });
    expect(m.rulesSnapshotHash([...FAKE_RULES].reverse())).toBe(rmeta.rules_identity.sha256);
    expect(m.rulesSnapshotHash([FAKE_RULES[0]!])).not.toBe(rmeta.rules_identity.sha256);
    expect(rmeta.rules_seed).toEqual(m.seedDirIdentity(rulesDir));
    expect(rmeta.rules_seed.files).toBe(1);
    expect(r.stdout).toContain(`generation ${rmeta.generation} · report_sha256 ${rmeta.report_sha256}`);
    expect(r.stdout).toContain(`engine build ${rmeta.engine.build.sha256} (${rmeta.engine.build.path}) · rules identity engine-list ${rmeta.rules_identity.sha256}`);
    // The published pair verifies on read; tmp+rename and the lock left nothing behind.
    expect(m.readPublishedReport(outDir).meta).toEqual(rmeta);
    expect(readdirSync(outDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([]);
  });

  it('S14c: refuses (exit 1, named mismatch, engine NEVER invoked) when samples.meta.json does not describe samples.json or came from another pin; a missing meta is exit 2', () => {
    okEngine();
    // Tampered samples: one more sample than the meta describes.
    const samples = JSON.parse(readFileSync(join(outDir, 'samples.json'), 'utf8')) as Sample[];
    samples.push({ ...samples[0]!, id: 'alpha@ffffffffffff' });
    writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples), 'utf8');
    const torn = runWithPath();
    expect(torn.status).toBe(1);
    expect(torn.stderr).toMatch(/samples_hash mismatch: .*samples\.meta\.json describes sha256:[0-9a-f]{64} but .*samples\.json hashes to sha256:[0-9a-f]{64} — a torn or foreign publication/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    expect(existsSync(join(fixture, 'engine-invoked'))).toBe(false); // verified BEFORE the engine is even probed

    // A meta derived from another pin (the samples themselves intact).
    expect(run('samples', outDir).status).toBe(0);
    const { meta } = readSamples();
    writeFileSync(join(outDir, 'samples.meta.json'), JSON.stringify({ ...meta, pin_hash: `sha256:${'0'.repeat(64)}` }), 'utf8');
    const foreign = runWithPath();
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/pin_hash mismatch: .*samples\.meta\.json was derived from sha256:0{64} but the selected pin is sha256:[0-9a-f]{64}/);
    expect(existsSync(join(fixture, 'engine-invoked'))).toBe(false);

    // A meta whose count disagrees.
    writeFileSync(join(outDir, 'samples.meta.json'), JSON.stringify({ ...meta, total: 99 }), 'utf8');
    expect(runWithPath().stderr).toMatch(/total mismatch: .* says 99 samples but .* holds 6/);

    // No meta at all.
    rmSync(join(outDir, 'samples.meta.json'));
    const missing = runWithPath();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/samples\.meta\.json is missing — run `samples/);
    expect(existsSync(join(fixture, 'engine-invoked'))).toBe(false);

    // Intact again ⇒ the engine runs.
    expect(run('samples', outDir).status).toBe(0);
    expect(runWithPath().status).toBe(0);
    expect(existsSync(join(fixture, 'engine-invoked'))).toBe(true);
  });

  it('an EMPTY report over staged samples is refused by name (exit 1, nothing published) — never recorded as a clean run; a COMPLETE report without rule_coverage (pre-#394 engine) is said so, not invented; an engine WITHOUT `rules list` records the seed-dir identity method by name; missing samples is a usage error', async () => {
    // What codex round 3 caught being published as a successful evaluation of the full corpus: an
    // engine answering `results: []` for six staged samples.
    fakeCore(
      'case "$1 $2" in "rules eval") printf \'{"results":[],"summary":{"total":0,"caught":0,"gaps":0,"false_positives":0},"degraded":null}\'; exit 0;; "rules ingest") exit 0;; "rules list") echo "usage: wicked-core <status | repos | run --problem ...> [--db <path>]"; exit 0;; esac; echo "wicked-core 9.9.9-fake"',
    );
    const empty = runWithPath();
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(
      /run: TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — the engine report is incomplete: 0 result row\(s\) for 6 staged sample\(s\) — 6 staged sample\(s\) have no result \("alpha@[0-9a-f]{12}", (".+?", ){3}"beta@[0-9a-f]{12}", … \(6 total\)\); every staged sample must be judged exactly once/,
    );
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    expect(existsSync(join(outDir, 'report.meta.json'))).toBe(false);
    // A COMPLETE report (one row per staged sample) that simply carries no rule_coverage, from an
    // engine whose `rules list` is the usage banner.
    okEngine({ ruleCoverage: false, rulesList: 'usage' });
    const r = runWithPath();
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as Report).summary).toEqual({ total: 6, caught: 6, gaps: 0, false_positives: 0 });
    expect(r.stdout).toContain('rule_coverage: not reported by this engine (predates core #394)');
    const rmeta = JSON.parse(readFileSync(join(outDir, 'report.meta.json'), 'utf8')) as ReportMeta;
    const m = await mod();
    expect(rmeta.rules_identity).toEqual({
      method: 'seed-dir',
      sha256: m.seedDirIdentity(rulesDir).sha256,
      rule_count: null,
      reason: expect.stringContaining('this engine has no `rules list` command'),
    });
    expect(r.stdout).toContain(`rules identity seed-dir ${rmeta.rules_identity.sha256}`);
    rmSync(join(outDir, 'samples.json'));
    const missing = runWithPath();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/samples\.json is missing — run `samples/);
  });

  it('an engine whose `rules list` exists but answers garbage (neither the JSON envelope nor a usage banner) is a TOOL FAILURE — the identity is never guessed', () => {
    fakeCore('case "$1 $2" in "rules ingest") exit 0;; "rules list") echo "rules list: 2 steering rule(s)"; exit 0;; esac; echo "wicked-core 9.9.9-fake"');
    const r = runWithPath();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — rules list failed \(exit 0\): rules list: 2 steering rule\(s\)/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  it('the --version probe: ENOENT is the documented SKIP; any other spawn error, a non-zero exit or an empty answer is a TOOL FAILURE (exit 1) — never a run under an unknown engine (Copilot)', () => {
    // Present but not executable ⇒ EACCES (PATH = the fake dir ALONE, so nothing else can answer).
    fakeCore('echo "wicked-core 9.9.9-fake"');
    chmodSync(join(fakeBin, coreBin), 0o644);
    const eacces = runWithPath('fake-only');
    expect(eacces.status).toBe(1);
    expect(eacces.stderr).toMatch(/run: TOOL FAILURE \(engine version unknown\) — wicked-core --version could not be executed \(EACCES\)/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    // Executable, but --version exits non-zero.
    fakeCore('case "$1" in --version) echo "unknown flag --version" >&2; exit 3;; esac; exit 0');
    const nonzero = runWithPath();
    expect(nonzero.status).toBe(1);
    expect(nonzero.stderr).toMatch(/TOOL FAILURE \(engine version unknown\) — wicked-core --version exited 3: unknown flag --version/);
    // Executable, exit 0, prints nothing — no version to record a run under.
    fakeCore('exit 0');
    const silent = runWithPath();
    expect(silent.status).toBe(1);
    expect(silent.stderr).toMatch(/wicked-core --version printed nothing/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  it('S14d: a published sample the ROUTE schema rejects (signals.phase/tool of the wrong type) is refused (exit 1) BEFORE the engine is probed — with samples_hash intact, so it is the schema, not the hash, that says no', async () => {
    okEngine();
    const m = await mod();
    const samples = JSON.parse(readFileSync(join(outDir, 'samples.json'), 'utf8')) as Record<string, unknown>[];
    samples[0]!['signals'] = { phase: 123, tool: [] };
    writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples), 'utf8');
    const { meta } = readSamples();
    writeFileSync(join(outDir, 'samples.meta.json'), JSON.stringify({ ...meta, samples_hash: m.samplesHash(samples as unknown as Sample[]) }), 'utf8');
    expect(ImportEvalCorpusSchema.safeParse({ name: 'x', samples }).success).toBe(false); // the route would 400 this
    const r = runWithPath();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/samples\.json: sample "alpha@[0-9a-f]{12}" is invalid: signals\.phase: Expected string, received number; signals\.tool: Expected string, received array/);
    expect(existsSync(join(fixture, 'engine-invoked'))).toBe(false);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  it('a result row naming a sample that was not staged, or echoing a different description, is a TOOL FAILURE — no report is published', () => {
    okEngine({ rowsJs: 'const results = [{ sample: { id: "smuggled@000000000000", description: "x", kind: "bad", steering_type: "security" }, expected: "deny", fired: [], verdict: "gap" }];' });
    const foreign = runWithPath();
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — results\[0\] names sample "smuggled@000000000000", which was not staged/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    okEngine({
      rowsJs: 'const results = samples.map((x) => ({ sample: { id: x.id, description: "not what was staged", kind: x.kind, steering_type: x.steering_type }, expected: "allow", fired: [], verdict: "caught" }));',
    });
    const drifted = runWithPath();
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toMatch(/results\[0\] \(alpha@[0-9a-f]{12}\) echoes description "not what was staged" but the staged sample has/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
  });

  it("S14h: the engine's report is refused (exit 1, named, nothing published) unless it holds EXACTLY one row per staged sample — a duplicate id, an extra id, a missing row, a row without an engine verdict or a `fired` array, or a summary that is not the rows' tally; a VALID all-gap report — BAD samples nothing caught — passes (gaps are findings)", async () => {
    const m = await mod();
    expect([...m.ENGINE_VERDICTS]).toEqual(['caught', 'gap', 'false_positive']);
    // One well-formed `caught` row for the staged sample `x` (double quotes only — it rides inside the fake's single quotes).
    const rowOf = '({ sample: { id: x.id, description: x.description, kind: x.kind, steering_type: x.steering_type }, expected: "allow", fired: [], verdict: "caught" })';
    const refusals: [string, RegExp, { rowsJs?: string; summaryJs?: string }][] = [
      ['duplicate id', /results\[6\] names sample alpha@[0-9a-f]{12} a second time — exactly one result per staged sample, never two/, { rowsJs: `const base = samples.map((x) => ${rowOf}); const results = [...base, base[0]];` }],
      [
        'extra id',
        /results\[6\] names sample "extra@000000000000", which was not staged — the engine evaluated something other than the pinned samples/,
        { rowsJs: `const results = samples.map((x) => ${rowOf}); results.push({ sample: { id: "extra@000000000000", description: "d", kind: "good", steering_type: "development" }, expected: "allow", fired: [], verdict: "caught" });` },
      ],
      [
        'missing row',
        /the engine report is incomplete: 5 result row\(s\) for 6 staged sample\(s\) — 1 staged sample\(s\) have no result \("alpha@[0-9a-f]{12}"\); every staged sample must be judged exactly once/,
        { rowsJs: `const results = samples.slice(1).map((x) => ${rowOf});` },
      ],
      ['missing verdict', /results\[0\] \(alpha@[0-9a-f]{12}\) carries verdict undefined, not one of caught\|gap\|false_positive/, { rowsJs: `const results = samples.map((x) => { const r = ${rowOf}; delete r.verdict; return r; });` }],
      ['unknown verdict', /results\[0\] \(alpha@[0-9a-f]{12}\) carries verdict "maybe", not one of caught\|gap\|false_positive/, { rowsJs: `const results = samples.map((x) => ({ ...${rowOf}, verdict: "maybe" }));` }],
      ['fired not an array', /results\[0\] \(alpha@[0-9a-f]{12}\) carries no `fired` array of rule ids \(got "DOC-1"\)/, { rowsJs: `const results = samples.map((x) => ({ ...${rowOf}, fired: "DOC-1" }));` }],
      ['fired of non-strings', /results\[0\] \(alpha@[0-9a-f]{12}\) carries no `fired` array of rule ids \(got \[1\]\)/, { rowsJs: `const results = samples.map((x) => ({ ...${rowOf}, fired: [1] }));` }],
      [
        'summary mismatch',
        /the engine report's summary does not reconcile with its rows: total 5 != 6, caught 7 != 6 \(the rows tally total 6 · caught 6 · gaps 0 · false_positives 0\)/,
        { summaryJs: '{ total: 5, caught: 7, gaps: 0, false_positives: 0 }' },
      ],
      ['summary field missing', /the engine report's summary does not reconcile with its rows: gaps undefined != 0 \(the rows tally/, { summaryJs: '{ total: results.length, caught: results.length, false_positives: 0 }' }],
    ];
    for (const [label, re, opts] of refusals) {
      okEngine(opts);
      const r = runWithPath();
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(/run: TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — /);
      expect(r.stderr, label).toMatch(re);
      expect(existsSync(join(outDir, 'report.json')), label).toBe(false);
      expect(existsSync(join(outDir, 'report.meta.json')), label).toBe(false);
    }
    // The pure verifier, on the same shapes, for the summary the tally must equal. All-gap is only
    // VALID over BAD samples — a gap is a bad behavior nothing caught (S14k has the good-sample case).
    const { samples } = readSamples();
    const badSamples = samples.map((x) => ({ ...x, kind: 'bad' as const }));
    const rows = badSamples.map((x) => ({ sample: { id: x.id, description: x.description, kind: x.kind, steering_type: x.steering_type }, expected: 'deny', fired: [], verdict: 'gap' }));
    expect(m.verifyEngineReport({ results: rows, summary: { total: 6, caught: 0, gaps: 6, false_positives: 0 }, degraded: null }, badSamples)).toBeNull();
    expect(m.verifyEngineReport({ results: rows, summary: { total: 6, caught: 6, gaps: 0, false_positives: 0 }, degraded: null }, badSamples)).toMatch(/^the engine report's summary does not reconcile with its rows: caught 6 != 0, gaps 0 != 6/);
    expect(m.verifyEngineReport({ results: rows, degraded: null }, badSamples)).toBe('the engine report carries no `summary` object');
    expect(m.verifyEngineReport({ results: [null] }, samples)).toBe('results[0] is not a result object');
    expect(m.verifyEngineReport([], samples)).toMatch(/not a report object with a `results` array/);
    // A VALID all-gap report: every staged sample is BAD (the known-bad allowlist names all six) and
    // nothing caught it — one row each, engine verdicts, `expected: deny`, empty `fired`, summary =
    // tally ⇒ exit 0, published, gaps printed as findings.
    writeFileSync(knownBadPath, JSON.stringify({ samples: Object.fromEntries(samples.map((x) => [x.id, { reason: 'fixture: every window commit judged bad' }])) }), 'utf8');
    expect(run('samples', outDir).status).toBe(0);
    expect(readSamples().samples.every((x) => x.kind === 'bad')).toBe(true);
    okEngine(); // the default rows: a bad sample ⇒ expected deny, fired [], verdict gap
    const gaps = runWithPath();
    expect(gaps.status, gaps.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as Report;
    expect(report.summary).toEqual({ total: 6, caught: 0, gaps: 6, false_positives: 0 });
    expect(report.results).toHaveLength(6);
    expect(report.results.every((row) => row.sample.kind === 'bad' && row.verdict === 'gap' && row.expected === 'deny' && row.fired.length === 0 && typeof row.sample.payload_hash === 'string')).toBe(true);
    expect(gaps.stdout).toContain('summary: total 6 · caught 0 · gaps 6 · false_positives 0');
    expect(m.readPublishedReport(outDir).report.summary.gaps).toBe(6);
  });

  it("S14k: a row INCONSISTENT with its sample's kind — a good sample judged `gap` (codex round 4: good + expected deny + empty fired + gap, the shape S14h used to bless), a bad one `false_positive`, `expected` missing or off its kind, `fired` disagreeing with the verdict — and a report whose `degraded` is absent or not null/facet-only, or whose `rule_coverage` is null or malformed, is refused by name before publication; `rule_coverage` ABSENT still passes", async () => {
    const m = await mod();
    expect([...m.ENGINE_DEGRADED_MODES]).toEqual(['facet-only']);
    const { samples } = readSamples(); // all good
    const good = samples[0]!;
    const bad = { ...samples[1]!, kind: 'bad' as const };
    const staged = [good, bad];
    const ref = (x: Sample) => ({ id: x.id, description: x.description, kind: x.kind, steering_type: x.steering_type });
    /** A result row as the engine would print it — any shape, so the malformed ones type too. */
    type Row = Record<string, unknown> & { verdict?: string };
    const goodCaught: Row = { sample: ref(good), expected: 'allow', fired: [], verdict: 'caught' };
    const badCaught: Row = { sample: ref(bad), expected: 'deny', fired: ['DOC-1'], verdict: 'caught' };
    const summaryOf = (rows: Row[]) => ({
      total: rows.length,
      caught: rows.filter((r) => r.verdict === 'caught').length,
      gaps: rows.filter((r) => r.verdict === 'gap').length,
      false_positives: rows.filter((r) => r.verdict === 'false_positive').length,
    });
    const report = (rows: Row[], top: Record<string, unknown> = {}): Record<string, unknown> => ({ results: rows, summary: summaryOf(rows), degraded: null, ...top });
    // The four CONSISTENT shapes pass: good caught (nothing fired), bad caught (a rule fired), good
    // false_positive (a rule fired), bad gap (nothing fired — with the engine's `nearest_rules`).
    expect(m.verifyEngineReport(report([goodCaught, badCaught]), staged)).toBeNull();
    expect(m.verifyEngineReport(report([{ ...goodCaught, fired: ['DOC-1'], verdict: 'false_positive' }, { ...badCaught, fired: [], verdict: 'gap', nearest_rules: [] }]), staged)).toBeNull();
    // Every impossible / inconsistent row, refused by name.
    const rowRefusals: [string, Row[], RegExp][] = [
      ['good + expected deny + empty fired + gap (codex round 4)', [{ ...goodCaught, expected: 'deny', verdict: 'gap' }, badCaught], /^results\[0\] \(alpha@[0-9a-f]{12}\) carries expected "deny" but a good sample expects "allow" \(the engine derives `expected` from `kind`\)$/],
      ['good judged gap (expected right)', [{ ...goodCaught, verdict: 'gap' }, badCaught], /^results\[0\] \(alpha@[0-9a-f]{12}\) is a good sample with verdict "gap" — impossible: a gap is a BAD behavior nothing caught \(a good sample is caught or false_positive\)$/],
      ['bad judged false_positive', [goodCaught, { ...badCaught, verdict: 'false_positive' }], /^results\[1\] \(alpha@[0-9a-f]{12}\) is a bad sample with verdict "false_positive" — impossible: a false positive is a GOOD behavior a rule denied \(a bad sample is caught or gap\)$/],
      ['expected missing', [{ sample: ref(good), fired: [], verdict: 'caught' }, badCaught], /^results\[0\] \(alpha@[0-9a-f]{12}\) carries expected undefined but a good sample expects "allow"/],
      ['expected off its kind (bad ⇒ allow)', [goodCaught, { ...badCaught, expected: 'allow' }], /^results\[1\] \(alpha@[0-9a-f]{12}\) carries expected "allow" but a bad sample expects "deny"/],
      ['fired non-empty on good caught', [{ ...goodCaught, fired: ['DOC-1'] }, badCaught], /^results\[0\] \(alpha@[0-9a-f]{12}\) says nothing blocking fired \(good ⇒ caught\) but `fired` names \["DOC-1"\] — deny-dominates: the verdict and the fired set must agree$/],
      ['fired empty on bad caught', [goodCaught, { ...badCaught, fired: [] }], /^results\[1\] \(alpha@[0-9a-f]{12}\) says a blocking rule fired \(bad ⇒ caught\) but `fired` is empty — deny-dominates: the verdict and the fired set must agree$/],
      ['fired non-empty on bad gap', [goodCaught, { ...badCaught, verdict: 'gap' }], /^results\[1\] \(alpha@[0-9a-f]{12}\) says nothing blocking fired \(bad ⇒ gap\) but `fired` names \["DOC-1"\]/],
      ['fired empty on good false_positive', [{ ...goodCaught, verdict: 'false_positive' }, badCaught], /^results\[0\] \(alpha@[0-9a-f]{12}\) says a blocking rule fired \(good ⇒ false_positive\) but `fired` is empty/],
    ];
    for (const [label, rows, re] of rowRefusals) expect(m.verifyEngineReport(report(rows), staged), label).toMatch(re);
    // Report-level wire fields: `degraded` is ALWAYS serialized by the engine — absent is malformed.
    const okRows = [goodCaught, badCaught];
    const withoutDegraded = report(okRows);
    delete withoutDegraded['degraded'];
    expect(m.verifyEngineReport(withoutDegraded, staged)).toBe('the engine report carries no `degraded` field (the wire shape always serializes it: null for full fidelity, "facet-only" when gap hints fell back to keyword matching)');
    expect(m.verifyEngineReport(report(okRows, { degraded: 'facet-only' }), staged)).toBeNull();
    for (const wrong of [true, false, 'yes', 0, {}]) {
      expect(m.verifyEngineReport(report(okRows, { degraded: wrong }), staged), JSON.stringify(wrong)).toBe(`the engine report's \`degraded\` is ${JSON.stringify(wrong)}, not null or one of facet-only`);
    }
    // `rule_coverage`: absent passes (an older engine); present must be well-formed — null is malformed.
    expect(m.verifyEngineReport(report(okRows, { rule_coverage: { exercised: 1, unexercised: [] } }), staged)).toBeNull();
    expect(m.verifyEngineReport(report(okRows, { rule_coverage: { exercised: 0, unexercised: [{ rule_id: 'DOC-1', steering_type: 'architecture' }] } }), staged)).toBeNull();
    const coverageRefusals: [unknown, RegExp][] = [
      [null, /^the engine report's `rule_coverage` is malformed: expected an object \{ exercised, unexercised\[\] \}, got null — an engine predating core #394 omits the field \(recorded as such\); a present field must be a well-formed \{ exercised, unexercised\[\] \}, never null$/],
      [[], /malformed: expected an object \{ exercised, unexercised\[\] \}, got \[\]/],
      [{ exercised: '3', unexercised: [] }, /malformed: exercised "3" is not a non-negative integer/],
      [{ exercised: -1, unexercised: [] }, /malformed: exercised -1 is not a non-negative integer/],
      [{ exercised: 1 }, /malformed: unexercised undefined is not an array/],
      [{ exercised: 1, unexercised: [{ steering_type: 'architecture' }] }, /malformed: unexercised\[0\] carries no string rule_id \(got \{"steering_type":"architecture"\}\)/],
      [{ exercised: 1, unexercised: [{ rule_id: 'DOC-1', steering_type: 'vibes' }] }, /malformed: unexercised\[0\] \(DOC-1\) steering_type "vibes" is not one of architecture\|development\|security\|testing\|operations\|compliance\|design-ux/],
    ];
    for (const [rc, re] of coverageRefusals) expect(m.verifyEngineReport(report(okRows, { rule_coverage: rc }), staged), JSON.stringify(rc)).toMatch(re);

    // Through the CLI — nothing published, the refusal named: codex round 4's exact report (good
    // samples with expected deny, empty fired, verdict gap — the shape S14h used to bless as a valid
    // all-gap run), `rule_coverage: null` (which then crashed the summary print AFTER publication),
    // a report without `degraded`, and a boolean `degraded`.
    const spawnRefusals: [string, Parameters<typeof okEngine>[0], RegExp][] = [
      [
        'good + deny + gap',
        { rowsJs: 'const results = samples.map((x) => ({ sample: { id: x.id, description: x.description, kind: x.kind, steering_type: x.steering_type }, expected: "deny", fired: [], verdict: "gap" }));' },
        /results\[0\] \(alpha@[0-9a-f]{12}\) carries expected "deny" but a good sample expects "allow"/,
      ],
      ['rule_coverage null', { coverageJs: ', rule_coverage: null' }, /the engine report's `rule_coverage` is malformed: expected an object \{ exercised, unexercised\[\] \}, got null/],
      ['degraded absent', { degradedJs: '' }, /the engine report carries no `degraded` field/],
      ['degraded boolean', { degradedJs: ', degraded: true' }, /the engine report's `degraded` is true, not null or one of facet-only/],
    ];
    for (const [label, opts, re] of spawnRefusals) {
      okEngine(opts);
      const r = runWithPath();
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(/run: TOOL FAILURE \(wicked-core 9\.9\.9-fake\) — /);
      expect(r.stderr, label).toMatch(re);
      expect(existsSync(join(outDir, 'report.json')), label).toBe(false);
      expect(existsSync(join(outDir, 'report.meta.json')), label).toBe(false);
    }
    // `degraded: null` (full fidelity) with `rule_coverage` ABSENT: published, and the summary print
    // says "not reported" instead of crashing.
    okEngine({ degradedJs: ', degraded: null', ruleCoverage: false });
    const r = runWithPath();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('summary: total 6 · caught 6 · gaps 0 · false_positives 0 · degraded null');
    expect(r.stdout).toContain('rule_coverage: not reported by this engine (predates core #394)');
    expect((JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as Report).degraded).toBeNull();
  });

  it('S14e: report.json + report.meta.json are ONE verifiable generation — an interruption between the two renames (report renamed, meta not) is refused on read by name, an edited meta generation too', async () => {
    okEngine();
    expect(runWithPath().status).toBe(0);
    const m = await mod();
    const good = m.readPublishedReport(outDir);
    expect(good.report.generation).toBe(good.meta.generation);
    // The interruption, simulated: a NEW report landed, the meta rename never happened.
    const before = readFileSync(join(outDir, 'report.json'), 'utf8');
    writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...good.report, generation: '20991231-235959-deadbeef' }), 'utf8');
    expect(() => m.readPublishedReport(outDir)).toThrow(m.RefusalError);
    expect(() => m.readPublishedReport(outDir)).toThrow(
      /^report_sha256 mismatch: .*report\.meta\.json describes sha256:[0-9a-f]{64} but .*report\.json hashes to sha256:[0-9a-f]{64} — a torn publication \(report and meta from different generations\) or a foreign report/,
    );
    writeFileSync(join(outDir, 'report.json'), before, 'utf8');
    expect(m.readPublishedReport(outDir).meta).toEqual(good.meta);
    // A meta whose generation was edited (its hash still matches the report bytes).
    writeFileSync(join(outDir, 'report.meta.json'), JSON.stringify({ ...good.meta, generation: '20991231-235959-deadbeef' }), 'utf8');
    expect(() => m.readPublishedReport(outDir)).toThrow(/^generation mismatch: .*report\.json is generation "\d{8}-\d{6}-[0-9a-f]{8}" but .*report\.meta\.json says "20991231-235959-deadbeef"/);
    // A missing half is a usage error.
    rmSync(join(outDir, 'report.meta.json'));
    expect(() => m.readPublishedReport(outDir)).toThrow(m.UsageError);
    expect(() => m.readPublishedReport(outDir)).toThrow(/report\.meta\.json is missing — run `run/);
  });

  it('S14f: a held .report.lock refuses the publication (exit 1, names the holder, nothing published, the lock untouched)', async () => {
    okEngine();
    const lock = join(outDir, (await mod()).REPORT_LOCK);
    writeFileSync(lock, 'pid 4242 generation 20260909-000000-deadbeef\n', 'utf8');
    const r = runWithPath();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/another `run` publication holds .*\.report\.lock \(pid 4242 generation 20260909-000000-deadbeef\) — refusing to interleave/);
    expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    expect(existsSync(join(outDir, 'report.meta.json'))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('pid 4242 generation 20260909-000000-deadbeef\n');
    rmSync(lock);
    expect(runWithPath().status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it(
    'S14g: two CONCURRENT publishers into one dir — each either publishes or is refused by the lock; the surviving pair verifies as one generation',
    async () => {
      okEngine();
      const spawnRun = () =>
        new Promise<{ status: number | null; stderr: string }>((resolveRun) => {
          const args = [SCRIPT, 'run', outDir, '--pin', pinPath, '--source-root', sourceRoot, '--rules', rulesDir];
          // `env` spreads process.env (the hermetic arming); re-stated for the harness-hygiene scan.
          const child = spawn(process.execPath, args, { env: { ...process.env, ...env, PATH: `${fakeBin}:${process.env['PATH'] ?? ''}` } });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          child.on('close', (status) => resolveRun({ status, stderr }));
        });
      const [x, y] = await Promise.all([spawnRun(), spawnRun()]);
      for (const r of [x, y]) {
        expect([0, 1]).toContain(r.status);
        if (r.status === 1) expect(r.stderr).toMatch(/another `run` publication holds .*\.report\.lock/);
      }
      expect([x.status, y.status]).toContain(0); // at least one published
      const m = await mod();
      const { report, meta } = m.readPublishedReport(outDir); // verifies report_sha256 + generation
      expect(report.generation).toBe(meta.generation);
      expect(readdirSync(outDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([]);
    },
    30_000,
  );
});

describe('publication — atomic (tmp+rename), locked, one generation per publication', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  }, HOOK_TIMEOUT);

  it('publishes samples.json + samples.meta.json via tmp+rename with one shared generation stamp, leaves no tmp or lock behind, and keeps samples.json byte-deterministic', async () => {
    const s = run('samples', outDir);
    expect(s.status, s.stderr).toBe(0);
    expect(readdirSync(outDir).sort()).toEqual(['samples.json', 'samples.meta.json']); // no .tmp, no lock
    const { samples, meta } = readSamples();
    expect(meta.generation).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(s.stdout).toContain(`generation ${meta.generation}`);
    // The pairing a reader verifies: the meta names THESE samples.
    expect(meta.samples_hash).toBe((await mod()).samplesHash(samples));
    // A second publication: new generation, same samples bytes (determinism is the array's, the
    // stamp is the publication's).
    const first = readFileSync(join(outDir, 'samples.json'), 'utf8');
    expect(run('samples', outDir).status).toBe(0);
    expect(readFileSync(join(outDir, 'samples.json'), 'utf8')).toBe(first);
    expect(readSamples().meta.generation).not.toBe(meta.generation);
    expect(readdirSync(outDir).sort()).toEqual(['samples.json', 'samples.meta.json']);
    // `pin` publishes the same way.
    expect(readdirSync(join(fixture, 'pin'))).toEqual(['wicked-internal-corpus.json']);
  });

  it('refuses (exit 1, names the holder) to publish while another publication holds the lock — never interleaves, never removes a lock it does not own', async () => {
    const lock = join(outDir, (await mod()).SAMPLES_LOCK);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(lock, 'pid 4242 generation 20260909-000000-deadbeef\n', 'utf8');
    const s = run('samples', outDir);
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/another `samples` publication holds .*\.samples\.lock \(pid 4242 generation 20260909-000000-deadbeef\) — refusing to interleave/);
    expect(existsSync(join(outDir, 'samples.json'))).toBe(false);
    expect(existsSync(join(outDir, 'samples.meta.json'))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('pid 4242 generation 20260909-000000-deadbeef\n'); // the holder's lock, untouched
    // Once released, publication proceeds and releases its own lock.
    rmSync(lock);
    expect(run('samples', outDir).status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('usage', () => {
  it('a bad mode, a missing <dir>, an unknown flag and a missing pin are usage errors (exit 2), never a silent pass', () => {
    expect(run('frobnicate').status).toBe(2);
    expect(run('frobnicate').stderr).toMatch(/usage:/);
    expect(run('samples').status).toBe(2);
    const unknown = spawnSync(process.execPath, [SCRIPT, 'check', '--bogus', 'x'], { env, encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/unknown flag --bogus/);
    rmSync(pinPath);
    const noPin = run('check');
    expect(noPin.status).toBe(2);
    expect(noPin.stderr).toMatch(/no pin at/);
  });
});

describe('the committed e2e/corpus/wicked-internal-corpus.json', () => {
  it('pins the five wicked repos at the agreed tags, hashes to its own pin_hash, meets the window floor, leaks no home path', async () => {
    const pin = readPin(COMMITTED_PIN);
    const m = await mod();
    expect(pin.repos.map((r) => [r.repo, r.tag])).toEqual([
      ['wicked-crew', 'v0.7.24'],
      ['wicked-estate', 'v0.16.6'],
      ['wicked-garden', 'v12.31.0'],
      ['wicked-interactive', 'v0.8.1'],
      ['wicked-studio', 'v0.5.0'],
    ]);
    expect(pin.window_rule).toEqual({ min_commits: 50, max_age_days: 180 });
    for (const r of pin.repos) {
      expect(r.remote).toBe(`https://github.com/mikeparcewski/${r.repo}.git`);
      expect(r.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.action_window_from_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.action_window_from_tag).toMatch(m.RELEASE_TAG_RE);
      expect(r.commit_sha).not.toBe(r.action_window_from_sha);
      // Either the floor is met, or the notes say SHORTFALL — never a silent thin window.
      if (r.commits < pin.window_rule.min_commits) expect(r.notes).toMatch(/^SHORTFALL/);
      else expect(r.notes).toMatch(/floor met/);
      expect(Date.parse(r.tag_date) - Date.parse(r.action_window_from_date)).toBeLessThanOrEqual(pin.window_rule.max_age_days * DAY);
    }
    expect(m.pinHash(pin.repos)).toBe(pin.pin_hash);
    expect(JSON.stringify(pin)).not.toMatch(/\/Users\/|\/home\//);
  });

  it('the committed known-bad allowlist is well-formed (empty until a human judges a commit)', () => {
    const kb = JSON.parse(readFileSync(COMMITTED_KNOWN_BAD, 'utf8')) as { description: string; samples: Record<string, { reason: string; steering_type?: string }> };
    expect(typeof kb.description).toBe('string');
    for (const [id, entry] of Object.entries(kb.samples)) {
      expect(id).toMatch(/^wicked-(estate|garden|crew|studio|interactive)@[0-9a-f]{12}$/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
