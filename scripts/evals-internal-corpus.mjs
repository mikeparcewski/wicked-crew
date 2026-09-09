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
 * this repo's parent dir), `--known-bad <file>` (samples), `--rules <dir>` (run). The source
 * checkouts are READ-ONLY to this script: only `git rev-parse` / `tag` / `log` / `rev-list` /
 * `archive` run against them — no fetch, no checkout, no worktree add.
 *
 * Exit codes: 0 ok / skipped-with-reason, 1 drift / refusal / tool failure, 2 usage or IO error.
 * Eval GAPS are findings, not failures — `run` exits 0 on a report full of gaps.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

class UsageError extends Error {}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    ...opts,
  }).trimEnd();
}

/** Codepoint order on `repo` — deterministic on every machine (`localeCompare` is locale-bound). */
function byRepo(a, b) {
  return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
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
  const { sha: tagSha, date: tagDate } = table.get(tag);
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

/** A pin whose `pin_hash` no longer matches its own tuples was hand-edited — refuse to trust it. */
function assertPinIntegrity(pin, pinPath) {
  if (typeof pin.pin_hash !== 'string') throw new UsageError(`${pinPath} carries no pin_hash — run \`pin\` first`);
  const expected = pinHash(pin.repos);
  if (pin.pin_hash !== expected) {
    throw new UsageError(
      `pin_hash mismatch: ${pinPath} says ${pin.pin_hash} but its own repos hash to ${expected} — ` +
        'the pin was hand-edited; re-run `pin` (moving a tag is a deliberate PR)',
    );
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
 * `check`: does every pinned tag (and window-from tag) still resolve to its recorded sha? Pure
 * over the git facts — returns per-repo findings so the CLI prints and the tests assert.
 *   drift[] — { repo, reason: 'tag' | 'from' | 'missing', detail }
 *   ok[]    — repos whose two shas both match
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

class DriftError extends Error {}

/**
 * `materialize <dir>`: `git archive` each pinned tag into `<dir>/<repo>@<tag>/` (a fresh tree —
 * an existing one is replaced). Refuses everything when ANY repo's sha does not match the pin.
 */
export function materialize(pin, pinPath, sourceRoot, outDir) {
  requirePinnedCheckouts(pin, pinPath, sourceRoot);
  mkdirSync(outDir, { recursive: true });
  const receipt = { pin_hash: pin.pin_hash, materialized_at: new Date().toISOString(), repos: [] };
  for (const r of [...pin.repos].sort(byRepo)) {
    const checkout = sourceCheckout(sourceRoot, r.repo);
    const dest = join(outDir, `${r.repo}@${r.tag}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const tarPath = `${dest}.tar`;
    git(checkout, ['archive', '--format=tar', '-o', tarPath, r.commit_sha]);
    const untar = spawnSync('tar', ['-xf', tarPath, '-C', dest], { encoding: 'utf8' });
    unlinkSync(tarPath);
    if (untar.status !== 0) {
      throw new Error(`tar -xf failed for ${r.repo}@${r.tag}: ${untar.stderr || untar.error?.message || `exit ${untar.status}`}`);
    }
    receipt.repos.push({ repo: r.repo, tag: r.tag, commit_sha: r.commit_sha, path: dest });
  }
  writeFileSync(join(outDir, 'materialized.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
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
 * The window's commits, newest first, from ONE `git log` (record separator \x1e, field separator
 * \x1f, then the touched paths one per line). `--diff-merges=first-parent` gives a merge commit
 * the files it landed on the mainline; `core.quotePath=false` keeps non-ASCII paths verbatim.
 */
export function windowCommits(checkout, fromSha, tagSha) {
  const raw = git(checkout, [
    '-c',
    'core.quotePath=false',
    'log',
    '--format=%x1e%H%x1f%s%x1f%b%x1f',
    '--name-only',
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
    const files = tail
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    commits.push({ sha, subject: subject.trim(), body: body.trim(), files });
  }
  return commits;
}

/** Read the known-bad allowlist: `{ samples: { "<repo>@<sha12>": { reason, steering_type? } } }`. */
export function readKnownBad(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = parsed.samples ?? {};
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
 * Mirror of crew's `EvalSampleSchema` (packages/crew/src/api/testing.ts — strict object, closed
 * `kind`, non-empty strings, strict `signals`) PLUS the engine's `EvalSample::validate` (a known
 * steering type). Zero-dep so the script stands alone; the vitest suite ALSO parses the written
 * file with the real zod schema. Returns the list of violations (empty = valid).
 */
export function validateSample(sample) {
  const problems = [];
  const keys = Object.keys(sample).sort();
  const expected = ['description', 'id', 'kind', 'signals', 'steering_type'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) problems.push(`keys ${keys.join(',')} != ${expected.join(',')}`);
  for (const k of ['id', 'description', 'steering_type']) {
    if (typeof sample[k] !== 'string' || sample[k].length === 0) problems.push(`${k} must be a non-empty string`);
  }
  if (sample.kind !== 'good' && sample.kind !== 'bad') problems.push(`kind ${JSON.stringify(sample.kind)} not good|bad`);
  if (!STEERING_TYPES.includes(sample.steering_type)) problems.push(`steering_type ${JSON.stringify(sample.steering_type)} unknown`);
  const s = sample.signals;
  if (s === null || typeof s !== 'object' || Array.isArray(s)) {
    problems.push('signals must be an object');
  } else {
    for (const k of Object.keys(s)) {
      if (!['phase', 'tool', 'files', 'content'].includes(k)) problems.push(`signals.${k} is not a known signal`);
    }
    if (s.files !== undefined && !(Array.isArray(s.files) && s.files.every((f) => typeof f === 'string'))) problems.push('signals.files must be string[]');
    if (s.content !== undefined && typeof s.content !== 'string') problems.push('signals.content must be a string');
  }
  return problems;
}

/**
 * `samples <dir>`: one EvalSample per window commit across the pinned repos — id
 * `<repo>@<sha12>`, `steering_type` from the path table, `files` = touched paths, `content` =
 * subject + body, `kind` good unless the known-bad allowlist names the id. Every sample is
 * validated; a known-bad id absent from the window is a stale allowlist entry and fails closed.
 */
export function deriveSamples(pin, pinPath, sourceRoot, knownBad) {
  requirePinnedCheckouts(pin, pinPath, sourceRoot);
  const samples = [];
  const perRepo = [];
  const unusedKnownBad = new Set(Object.keys(knownBad));
  for (const r of [...pin.repos].sort(byRepo)) {
    const checkout = sourceCheckout(sourceRoot, r.repo);
    const commits = windowCommits(checkout, r.action_window_from_sha, r.commit_sha);
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
    perRepo.push({ repo: r.repo, from: r.action_window_from_tag, tag: r.tag, commits: commits.length });
  }
  if (unusedKnownBad.size > 0) {
    throw new DriftError(
      `known-bad names ${unusedKnownBad.size} id(s) not in any pinned window (stale entry or a moved tag): ${[...unusedKnownBad].sort().join(', ')}`,
    );
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

function writeSamples(outDir, samples, meta) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'samples.meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * `run <dir>`: only when `wicked-core` is on PATH — ingest the doctrine seed into a TEMP rules
 * store, then `rules eval` the derived samples (staged as a one-file corpus DIR: the engine's
 * `--corpus` takes a directory of sample *.json files or an `evals:` scope, never a file) with a
 * TEMP knowledge db, and write the report. Non-zero only when the tool itself fails.
 */
export function runEvals(outDir, rulesDir, coreBin = CORE_BIN) {
  const samplesPath = join(outDir, 'samples.json');
  if (!existsSync(samplesPath)) throw new UsageError(`${samplesPath} is missing — run \`samples ${outDir}\` first`);
  const probe = spawnSync(coreBin, ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    return { skipped: `${coreBin} is not on PATH — nothing to run (install wicked-core to eval the corpus)` };
  }
  if (!existsSync(rulesDir)) throw new UsageError(`rules seed dir ${rulesDir} does not exist (pass --rules <dir>)`);
  const tmp = mkdtempSync(join(tmpdir(), 'evals-internal-corpus-'));
  try {
    const rulesDb = join(tmp, 'rules.db');
    const knowledgeDb = join(tmp, 'knowledge.db');
    const ingest = spawnSync(coreBin, ['rules', 'ingest', rulesDir, '--db', rulesDb], { encoding: 'utf8' });
    if (ingest.status !== 0) {
      return { failure: `rules ingest failed (exit ${ingest.status}): ${(ingest.stderr || ingest.stdout).trim()}`, engine: probe.stdout.trim() };
    }
    const corpusDir = join(outDir, 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    copyFileSync(samplesPath, join(corpusDir, 'samples.json'));
    const evalRun = spawnSync(coreBin, ['rules', 'eval', '--db', rulesDb, '--knowledge-db', knowledgeDb, '--corpus', corpusDir, '--json'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (evalRun.status !== 0) {
      return { failure: `rules eval failed (exit ${evalRun.status}): ${(evalRun.stderr || evalRun.stdout).trim()}`, engine: probe.stdout.trim() };
    }
    let report;
    try {
      report = JSON.parse(evalRun.stdout);
    } catch (err) {
      return { failure: `rules eval printed no JSON report: ${err.message}\n${evalRun.stdout.slice(0, 400)}`, engine: probe.stdout.trim() };
    }
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { report, engine: probe.stdout.trim() };
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
  console.log(`rule_coverage: exercised ${rc.exercised} · unexercised ${rc.unexercised.length}`);
  for (const u of rc.unexercised) console.log(`  unexercised ${u.rule_id} (${u.steering_type})`);
}

function main(argv) {
  const { mode, dir, pinPath, sourceRoot, knownBadPath, rulesDir } = parseArgs(argv);
  if (mode === 'pin') {
    const pin = buildPin(pinPath, sourceRoot);
    mkdirSync(dirname(pinPath), { recursive: true });
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
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
    const receipt = materialize(pin, pinPath, sourceRoot, dir);
    for (const r of receipt.repos) console.log(`  archived  ${r.repo}@${r.tag} (${r.commit_sha.slice(0, SHORT_SHA_LEN)}) → ${r.path}`);
    console.log(`evals-internal-corpus: materialized ${receipt.repos.length} repos under ${dir} (pin_hash ${receipt.pin_hash})`);
    return EXIT_OK;
  }
  if (mode === 'samples') {
    const { samples, meta } = deriveSamples(pin, pinPath, sourceRoot, readKnownBad(knownBadPath));
    writeSamples(dir, samples, meta);
    for (const w of meta.windows) console.log(`  derived   ${w.repo} ${w.from}..${w.tag} = ${w.commits} samples`);
    console.log(`  steering  ${Object.entries(meta.steering_types).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
    console.log(`evals-internal-corpus: ${meta.total} samples (${meta.bad} bad) → ${join(dir, 'samples.json')} · samples_hash ${meta.samples_hash} · corpus ${meta.corpus_name}`);
    return EXIT_OK;
  }
  // run
  const result = runEvals(dir, rulesDir ?? join(sourceRoot, DEFAULT_RULES_SEED_REL));
  if (result.skipped !== undefined) {
    console.log(`evals-internal-corpus run: SKIP — ${result.skipped}`);
    return EXIT_OK;
  }
  if (result.failure !== undefined) {
    console.error(`evals-internal-corpus run: TOOL FAILURE (${result.engine}) — ${result.failure}`);
    return EXIT_DRIFT;
  }
  console.log(`evals-internal-corpus run (${result.engine}) → ${join(dir, 'report.json')}`);
  printSummary(result.report);
  return EXIT_OK;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`evals-internal-corpus: ${message}`);
    process.exitCode = err instanceof DriftError ? EXIT_DRIFT : EXIT_USAGE;
  }
}
