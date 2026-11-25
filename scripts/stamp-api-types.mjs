#!/usr/bin/env node
// Stamp wicked-crew-api-types once per release train, and guard that the stamp happened.
//
//   npm run stamp:api-types -- <X.Y.Z>     the train's crew version PR: write the version everywhere
//   npm run stamp:api-types -- --check     a release guard: fail on an unfinished or missing stamp
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
//   - package-lock.json: the same two fields, edited in place (no install, nothing fetched);
//   - every `api-types next` tag in index.d.ts, crew's src and the CHANGELOG: `api-types X.Y.Z`;
//   - crew's endpoint manifest and API sample test: through their generators, which read the version.
//
// `--check` fails when:
//   - an `api-types next` tag is left (a stamp is due, or one missed a tag);
//   - a workspace's caret or the lockfile does not name the package's version;
//   - packages/crew-api-types differs from the tag api-types-v<its version>, when that tag exists
//     (the contract changed after its version was published, and nobody stamped a new one).
//
// `--root <dir>` runs against another checkout (the tests use it). Plain node, no dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'wicked-crew-api-types';
const TYPES_DIR = 'packages/crew-api-types';
// A tag is `(api-types next` or `(crew#1, api-types next` at the start of a parenthesis. A mention in
// a code span, `(api-types next)` with a backtick before it, is prose about the rule and stays.
const NEXT = /(?<!`)(\((?:[^()`\n]*?[ ,])?)api-types next\b/g;
const HAS_NEXT = new RegExp(NEXT.source);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// Where an `api-types next` tag is written: the contract itself, crew's source doc comments, and the
// CHANGELOG. Tests, scripts and the package README are not stamped (they may spell the tag on purpose).
const TAGGED = (path) =>
  path === `${TYPES_DIR}/index.d.ts` || path.startsWith('packages/crew/src/') || path === 'CHANGELOG.md';
const SEMVER = /^\d+\.\d+\.\d+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The tracked files that may carry an `api-types next` tag. */
function taggedFiles(root) {
  return git(root, 'ls-files', '-z').split('\0').filter((p) => p && TAGGED(p));
}

/** The workspace package.json paths, from the root package.json's `workspaces` (plain paths only). */
function workspaces(root) {
  const ws = readJson(join(root, 'package.json')).workspaces ?? [];
  return (Array.isArray(ws) ? ws : ws.packages ?? []).filter((w) => !w.includes('*'));
}

function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Point one manifest's (or lockfile entry's) dependency on the contract at `^version`. */
function setCaret(entry, version) {
  let changed = false;
  for (const field of DEP_FIELDS) {
    if (entry?.[field] && typeof entry[field][PKG] === 'string' && entry[field][PKG] !== `^${version}`) {
      entry[field][PKG] = `^${version}`;
      changed = true;
    }
  }
  return changed;
}

/** Every caret on the contract, as `[where, spec]`, from the workspaces and the lockfile. */
function carets(root) {
  const out = [];
  for (const ws of workspaces(root)) {
    if (ws === TYPES_DIR) continue;
    const pj = readJson(join(root, ws, 'package.json'));
    for (const field of DEP_FIELDS) if (typeof pj[field]?.[PKG] === 'string') out.push([`${ws}/package.json`, pj[field][PKG]]);
  }
  const lock = readJson(join(root, 'package-lock.json'));
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === TYPES_DIR) continue;
    for (const field of DEP_FIELDS) if (typeof entry?.[field]?.[PKG] === 'string') out.push([`package-lock.json "${key}"`, entry[field][PKG]]);
  }
  return out;
}

export function stamp(root, version) {
  if (!SEMVER.test(version)) throw new Error(`usage: stamp-api-types <X.Y.Z> (got '${version}')`);
  const typesPj = join(root, TYPES_DIR, 'package.json');
  const pj = readJson(typesPj);
  if (compare(version, pj.version) < 0) {
    throw new Error(`${PKG} is at ${pj.version}; ${version} would move it back`);
  }
  const touched = [];
  if (pj.version !== version) {
    pj.version = version;
    writeJson(typesPj, pj);
    touched.push(`${TYPES_DIR}/package.json`);
  }
  for (const ws of workspaces(root)) {
    if (ws === TYPES_DIR) continue;
    const path = join(root, ws, 'package.json');
    const wpj = readJson(path);
    if (setCaret(wpj, version)) {
      writeJson(path, wpj);
      touched.push(`${ws}/package.json`);
    }
  }
  const lockPath = join(root, 'package-lock.json');
  const lock = readJson(lockPath);
  let lockChanged = false;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === TYPES_DIR && entry.version !== version) {
      entry.version = version;
      lockChanged = true;
    } else if (key !== TYPES_DIR && setCaret(entry, version)) {
      lockChanged = true;
    }
  }
  if (lockChanged) {
    writeJson(lockPath, lock);
    touched.push('package-lock.json');
  }
  for (const path of taggedFiles(root)) {
    const text = readFileSync(join(root, path), 'utf8');
    const next = text.replace(NEXT, `$1api-types ${version}`);
    if (next !== text) {
      writeFileSync(join(root, path), next);
      touched.push(path);
    }
  }
  // The generators read the version from packages/crew-api-types/package.json themselves.
  for (const script of ['manifest:endpoints', 'generate:api-tests']) {
    execFileSync('npm', ['run', '--silent', script, '--workspace', 'packages/crew'], { cwd: root, stdio: 'inherit' });
  }
  return touched;
}

export function check(root) {
  const problems = [];
  const version = readJson(join(root, TYPES_DIR, 'package.json')).version;
  for (const path of taggedFiles(root)) {
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (HAS_NEXT.test(line)) problems.push(`${path}:${i + 1} still says 'api-types next'`);
      });
  }
  const lock = readJson(join(root, 'package-lock.json'));
  if (lock.packages?.[TYPES_DIR]?.version !== version) {
    problems.push(`package-lock.json names ${PKG} ${lock.packages?.[TYPES_DIR]?.version}, its package.json ${version}`);
  }
  for (const [where, spec] of carets(root)) {
    if (spec !== `^${version}`) problems.push(`${where} asks for ${PKG} ${spec}, not ^${version}`);
  }
  const tag = `api-types-v${version}`;
  let tagged = false;
  try {
    git(root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`);
    tagged = true;
  } catch {
    // No such tag here: this version is not released yet, so there is nothing to compare against.
  }
  if (tagged) {
    const changed = git(root, 'diff', '--name-only', tag, 'HEAD', '--', TYPES_DIR).trim();
    if (changed) {
      problems.push(
        `${TYPES_DIR} changed since ${tag} was tagged (${changed.split('\n').join(', ')}), and its version did not move`,
      );
    }
  }
  return { version, tagged, problems };
}

function main(argv) {
  let root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i]);
    else args.push(argv[i]);
  }
  if (args.length === 1 && args[0] === '--check') {
    const { version, tagged, problems } = check(root);
    if (problems.length) {
      for (const p of problems) console.error(`::error::${p}`);
      console.error(`${PKG} needs a stamp: run npm run stamp:api-types -- <X.Y.Z> in the train's crew version PR.`);
      return 1;
    }
    console.log(
      `${PKG} ${version} is stamped (${tagged ? `matches api-types-v${version}` : `api-types-v${version} is not tagged yet`}).`,
    );
    return 0;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('usage: stamp-api-types <X.Y.Z> | --check  [--root <dir>]');
    return 2;
  }
  try {
    const touched = stamp(root, args[0]);
    console.log(`stamped ${PKG} ${args[0]}:`);
    for (const t of touched) console.log(`  ${t}`);
    console.log('  packages/crew/endpoint-manifest.json and the API sample test, through their generators');
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
