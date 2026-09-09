// evals-internal-corpus (scripts/evals-internal-corpus.mjs) — the INTERNAL evals corpus: five
// wicked repos at pinned prior release tags, with an action window of real commits behind each.
//
// Proven over FIXTURE mini-repos with tags (never the sibling checkouts): the pin resolves shas
// and windows by the rule (>= min_commits, capped at max_age_days before the tag's own date;
// shortfall recorded, never widened); `check` fails closed on sha drift (a re-cut tag) and on a
// hand-edited pin; `samples` derives one EvalSample per window commit that the REAL crew zod
// schema accepts, infers steering_type from the explicit path table (unsure ⇒ development),
// honors the known-bad allowlist and fails closed on a stale entry; `materialize` refuses a pin
// whose sha no longer matches; `run` skips without wicked-core, fails loud when the tool fails,
// and writes the report when it succeeds (a fake binary stands in for the engine). Plus the
// committed pin's structural facts.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ImportEvalCorpusSchema } from '../src/api/testing.js';

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
}
/** The script's exported pure functions (typed here — the file is plain JS). */
interface CorpusModule {
  pinHash: (repos: PinRepo[]) => string;
  samplesHash: (samples: Sample[]) => string;
  classifyPath: (path: string) => string | null;
  inferSteeringType: (files: string[]) => string;
  corpusName: (pinHash: string) => string;
  RELEASE_TAG_RE: RegExp;
  STEERING_TYPES: readonly string[];
  CORE_BIN: string;
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

/** A fixed clock for the fixture commits: dates are what the age cap reasons over. */
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 86_400_000;

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
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), `${message}\n`, 'utf8');
  git(dir, 'add', path);
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
  const args = [SCRIPT, mode, ...extra, '--pin', pinPath, '--source-root', sourceRoot, '--known-bad', knownBadPath];
  const res = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
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
});

describe('check — the tags still resolve to the pinned shas', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  });

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
});

describe('samples — one EvalSample per window commit', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  });

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
});

describe('materialize — git archive of each pinned tag', () => {
  beforeEach(() => {
    expect(run('pin').status).toBe(0);
  });

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
  });

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

  it('writes <dir>/report.json from the engine\'s JSON, stages the samples as a corpus DIR, prints summary + rule_coverage, exits 0 on gaps', () => {
    // The fake asserts the CONTRACT the real CLI has: `--corpus` is a directory of *.json samples
    // (never a file), and `--db` / `--knowledge-db` are TEMP paths (never the operator's home).
    fakeCore(
      [
        'case "$1 $2" in',
        '  "rules ingest") [ -d "$3" ] || { echo "no seed dir" >&2; exit 1; }; exit 0;;',
        '  "rules eval")',
        '    corpus=""; db=""; kdb="";',
        '    while [ $# -gt 0 ]; do case "$1" in --corpus) corpus="$2"; shift;; --db) db="$2"; shift;; --knowledge-db) kdb="$2"; shift;; esac; shift; done',
        '    [ -d "$corpus" ] || { echo "--corpus must be a DIRECTORY, got $corpus" >&2; exit 1; }',
        '    [ -f "$corpus/samples.json" ] || { echo "corpus dir lacks samples.json" >&2; exit 1; }',
        `    case "$db" in "${outDir}"*|"$HOME/.wicked"*) echo "db must be a temp path, got $db" >&2; exit 1;; esac`,
        '    [ -n "$kdb" ] || { echo "no --knowledge-db" >&2; exit 1; }',
        '    n=$(grep -c \'"id":\' "$corpus/samples.json")',
        '    printf \'{"results":[],"summary":{"total":%s,"caught":0,"gaps":%s,"false_positives":0},"degraded":"facet-only","rule_coverage":{"exercised":0,"unexercised":[{"rule_id":"DOC-1","steering_type":"architecture"}]}}\' "$n" "$n"',
        '    exit 0;;',
        'esac',
        'echo "wicked-core 9.9.9-fake"',
      ].join('\n'),
    );
    const r = runWithPath();
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as { summary: { total: number; gaps: number }; rule_coverage: { unexercised: unknown[] } };
    expect(report.summary).toEqual({ total: 6, caught: 0, gaps: 6, false_positives: 0 });
    expect(report.rule_coverage.unexercised).toEqual([{ rule_id: 'DOC-1', steering_type: 'architecture' }]);
    expect(existsSync(join(outDir, 'corpus', 'samples.json'))).toBe(true);
    expect(r.stdout).toContain('summary: total 6 · caught 0 · gaps 6 · false_positives 0 · degraded "facet-only"');
    expect(r.stdout).toContain('rule_coverage: exercised 0 · unexercised 1');
    expect(r.stdout).toContain('unexercised DOC-1 (architecture)');
  });

  it('a report without rule_coverage (pre-#394 engine) is said so, not invented; missing samples is a usage error', () => {
    fakeCore('case "$1 $2" in "rules eval") printf \'{"results":[],"summary":{"total":0,"caught":0,"gaps":0,"false_positives":0},"degraded":null}\'; exit 0;; "rules ingest") exit 0;; esac; echo "wicked-core 9.9.9-fake"');
    const r = runWithPath();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('rule_coverage: not reported by this engine (predates core #394)');
    rmSync(join(outDir, 'samples.json'));
    const missing = runWithPath();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/samples\.json is missing — run `samples/);
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
