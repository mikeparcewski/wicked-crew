#!/usr/bin/env node
// Stamp wicked-crew-api-types once per release train, and guard that the stamp happened.
//
//   npm run stamp:api-types -- <X.Y.Z>                 the train's crew version PR: write the version
//   npm run stamp:api-types -- --check [--remote <r>]  a guard: fail on an unfinished or missing stamp
//
// The rule (coord, 2026-11-25, train 15): a feature PR that changes packages/crew-api-types leaves
// the package version, crew's caret on it and package-lock.json alone, and tags what it adds with
// `(api-types next)` instead of a number. The train's crew version PR runs this script once. Before,
// every feature PR stamped a number of its own, so two PRs in flight collided and had to re-stamp
// (and re-run CI), and most stamps never reached npm.
//
// A stamp writes:
//   - packages/crew-api-types/package.json: the version;
//   - every workspace package.json that depends on wicked-crew-api-types: the caret `^X.Y.Z`;
//   - package-lock.json: the same fields of the same workspace entries, edited in place (no install,
//     nothing fetched; third-party entries are never touched);
//   - every `api-types next` tag in index.d.ts, the workspaces' src and the CHANGELOG: `api-types X.Y.Z`;
//   - crew's endpoint manifest and API sample test: through their generators, which read the version.
//
// A tag is the words `api-types next` outside a code span: `(api-types next)`, `(crew#1, api-types next)`,
// `@deprecated (api-types next)`, a list item `- api-types next: …`, and a parenthesis wrapped across comment
// lines all count. The words themselves stay on one line. A mention inside backticks is prose about the rule.
//
// `--check` fails when:
//   - an `api-types next` tag is left (a stamp is due, or one missed a tag);
//   - a version is not X.Y.Z;
//   - a workspace manifest, its lockfile entry or crew's endpoint manifest names another version;
//   - packages/crew-api-types (as it stands on disk) differs from the tag api-types-v<its version>, when
//     that tag exists: the contract changed after its version was published, and nobody stamped a new one.
// With `--remote <name>`, whether that tag exists is asked of the remote (and the tag is fetched), and a
// remote that cannot be asked fails the check; without it, the local tags answer.
//
// `--root <dir>` runs against another checkout (the tests use it). Plain node, no dependencies.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'wicked-crew-api-types';
const TYPES_DIR = 'packages/crew-api-types';
const TAG_WORDS = /\bapi-types next\b/g;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// Where an `api-types next` tag is written: the contract itself, the workspaces' source doc comments, and the
// CHANGELOG. Tests, scripts and the READMEs are not stamped (they may spell the tag on purpose).
const TAGGED = (path) => path === `${TYPES_DIR}/index.d.ts` || /^packages\/[^/]+\/src\//.test(path) || path === 'CHANGELOG.md';
// A release version npm accepts: no leading zeros, and parts small enough to compare as numbers.
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The files that may carry a tag: tracked ones and new ones git does not ignore. */
function taggedFiles(root) {
  return git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter((p, i, all) => p && TAGGED(p) && all.indexOf(p) === i);
}

/** Each tag in `text` as `{ index, line }`; a match after an odd number of backticks on its line is in a code span. */
function tagsIn(text) {
  const out = [];
  for (const m of text.matchAll(TAG_WORDS)) {
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const ticks = (text.slice(lineStart, m.index).match(/`/g) ?? []).length;
    if (ticks % 2 === 0) out.push({ index: m.index, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** The workspace directories, from the root package.json's `workspaces`. */
function workspaces(root) {
  const ws = readJson(join(root, 'package.json')).workspaces ?? [];
  const list = Array.isArray(ws) ? ws : (ws.packages ?? []);
  const glob = list.find((w) => w.includes('*'));
  if (glob) throw new Error(`workspace '${glob}' is a pattern; this script reads plain workspace paths only`);
  return list;
}

function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Each `[workspace, field]` whose manifest depends on the contract. */
function dependents(root) {
  const out = [];
  for (const ws of workspaces(root)) {
    if (ws === TYPES_DIR) continue;
    const pj = readJson(join(root, ws, 'package.json'));
    for (const field of DEP_FIELDS) if (typeof pj[field]?.[PKG] === 'string') out.push([ws, field]);
  }
  return out;
}

export function stamp(root, version) {
  if (!SEMVER.test(version)) throw new Error(`usage: stamp-api-types <X.Y.Z> (got '${version}')`);
  const typesPj = join(root, TYPES_DIR, 'package.json');
  const pj = readJson(typesPj);
  if (!SEMVER.test(pj.version)) throw new Error(`${PKG}'s version '${pj.version}' is not X.Y.Z; fix it by hand first`);
  if (compare(version, pj.version) < 0) throw new Error(`${PKG} is at ${pj.version}; ${version} would move it back`);
  const deps = dependents(root);
  const lockPath = join(root, 'package-lock.json');
  const lock = readJson(lockPath);
  const missing = [TYPES_DIR, ...deps.map(([ws]) => ws)].find((ws) => typeof lock.packages?.[ws] !== 'object');
  // Every check that can refuse runs before the first write, so a refusal leaves the tree as it was.
  if (missing) throw new Error(`package-lock.json has no entry for the workspace ${missing}; run npm install first`);

  const caret = `^${version}`;
  const touched = new Set();
  if (pj.version !== version) {
    pj.version = version;
    writeJson(typesPj, pj);
    touched.add(`${TYPES_DIR}/package.json`);
  }
  for (const [ws, field] of deps) {
    const path = join(root, ws, 'package.json');
    const wpj = readJson(path);
    if (wpj[field][PKG] !== caret) {
      wpj[field][PKG] = caret;
      writeJson(path, wpj);
      touched.add(`${ws}/package.json`);
    }
    const entry = lock.packages[ws];
    if (entry[field]?.[PKG] !== caret) {
      entry[field] = { ...entry[field], [PKG]: caret };
      touched.add('package-lock.json');
    }
  }
  if (lock.packages[TYPES_DIR].version !== version) {
    lock.packages[TYPES_DIR].version = version;
    touched.add('package-lock.json');
  }
  if (touched.has('package-lock.json')) writeJson(lockPath, lock);
  for (const path of taggedFiles(root)) {
    const text = readFileSync(join(root, path), 'utf8');
    const tags = tagsIn(text);
    if (tags.length === 0) continue;
    let next = '';
    let from = 0;
    for (const { index } of tags) {
      next += `${text.slice(from, index)}api-types ${version}`;
      from = index + 'api-types next'.length;
    }
    writeFileSync(join(root, path), next + text.slice(from));
    touched.add(path);
  }
  // The generators read the version from packages/crew-api-types/package.json themselves.
  for (const script of ['manifest:endpoints', 'generate:api-tests']) {
    execFileSync('npm', ['run', '--silent', script, '--workspace', 'packages/crew'], { cwd: root, stdio: 'inherit' });
  }
  return [...touched];
}

/** Whether `refs/tags/<tag>` exists. With a remote, ask it (and fetch the tag when it exists); a remote that cannot
 *  be asked is an error, never "not tagged". */
function tagExists(root, tag, remote) {
  if (remote !== undefined) {
    const ls = spawnSync('git', ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`], { cwd: root, encoding: 'utf8' });
    if (ls.status === 2) return false;
    if (ls.status !== 0) throw new Error(`cannot ask ${remote} whether ${tag} exists: ${(ls.stderr || ls.error?.message || '').trim()}`);
    git(root, 'fetch', '-q', '--depth=1', remote, `+refs/tags/${tag}:refs/tags/${tag}`);
    return true;
  }
  return spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { cwd: root }).status === 0;
}

export function check(root, remote) {
  const problems = [];
  const version = readJson(join(root, TYPES_DIR, 'package.json')).version;
  if (!SEMVER.test(version)) problems.push(`${TYPES_DIR}/package.json version '${version}' is not X.Y.Z`);
  for (const path of taggedFiles(root)) {
    for (const { line } of tagsIn(readFileSync(join(root, path), 'utf8'))) problems.push(`${path}:${line} still says 'api-types next'`);
  }
  const caret = `^${version}`;
  const lock = readJson(join(root, 'package-lock.json'));
  if (lock.packages?.[TYPES_DIR]?.version !== version) {
    problems.push(`package-lock.json names ${PKG} ${lock.packages?.[TYPES_DIR]?.version}, its package.json ${version}`);
  }
  for (const [ws, field] of dependents(root)) {
    const spec = readJson(join(root, ws, 'package.json'))[field][PKG];
    if (spec !== caret) problems.push(`${ws}/package.json ${field} asks for ${PKG} ${spec}, not ${caret}`);
    const locked = lock.packages?.[ws]?.[field]?.[PKG];
    if (locked !== caret) problems.push(`package-lock.json "${ws}" ${field} asks for ${PKG} ${locked ?? '(nothing)'}, not ${caret}`);
  }
  try {
    const manifest = readJson(join(root, 'packages/crew/endpoint-manifest.json')).apiTypesVersion;
    if (manifest !== version) problems.push(`packages/crew/endpoint-manifest.json names ${PKG} ${manifest}; run npm run -w packages/crew manifest:endpoints`);
  } catch {
    problems.push('packages/crew/endpoint-manifest.json cannot be read');
  }
  const tag = `api-types-v${version}`;
  const tagged = tagExists(root, tag, remote);
  if (tagged) {
    // The tree on disk (staged or not), plus new files, against the published one.
    const changed = [
      ...git(root, 'diff', '--name-only', tag, '--', TYPES_DIR).split('\n'),
      ...git(root, 'ls-files', '--others', '--exclude-standard', '--', TYPES_DIR).split('\n'),
    ].filter(Boolean);
    if (changed.length) problems.push(`${TYPES_DIR} changed since ${tag} was tagged (${changed.join(', ')}), and its version did not move`);
  }
  return { version, tagged, problems };
}

function main(argv) {
  let root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let remote;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i]);
    else if (argv[i] === '--remote') remote = argv[++i];
    else args.push(argv[i]);
  }
  try {
    if (args.length === 1 && args[0] === '--check') {
      const { version, tagged, problems } = check(root, remote);
      if (problems.length) {
        for (const p of problems) console.error(`::error::${p}`);
        console.error(`${PKG} needs a stamp: run npm run stamp:api-types -- <X.Y.Z> in the train's crew version PR.`);
        return 1;
      }
      console.log(`${PKG} ${version} is stamped (${tagged ? `matches api-types-v${version}` : `api-types-v${version} is not tagged yet`}).`);
      return 0;
    }
    if (args.length !== 1 || args[0].startsWith('-') || remote !== undefined) {
      console.error('usage: stamp-api-types <X.Y.Z> | --check [--remote <name>]  [--root <dir>]');
      return 2;
    }
    const touched = stamp(root, args[0]);
    console.log(`stamped ${PKG} ${args[0]}:`);
    for (const t of touched) console.log(`  ${t}`);
    console.log('  packages/crew/endpoint-manifest.json and the API sample test, through their generators');
    return 0;
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
