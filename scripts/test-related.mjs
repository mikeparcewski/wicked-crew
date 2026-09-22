#!/usr/bin/env node
// The engine's change-scoped test command for this repo (core#482 ship half — FIX-IT-ALL L10-8).
//
// `.wicked/checks.json` declares `"test_targeted": ["node", "scripts/test-related.mjs", "{files}"]`:
// the repo-checks floor splices one argv entry per touched file, spelled RELATIVE TO THE WORKTREE
// ROOT (`git diff --name-only` + `ls-files --others` at the root — `packages/crew/src/x.ts`), and runs
// it from the root at the creator's and the verifier's floor (`full: false`; the FULL suite stays
// CI's PR gate — it blew the 1200 s verify bound under host load, F-RC2-050). vitest resolves
// `related` paths against ITS root, so the one-liner cannot work from the root: `--root packages/crew`
// + root-relative files doubles the prefix, and without `--root` crew's config (hermetic setup files)
// is not loaded. This script is the one deterministic place for that translation:
//
//   1. keep the files under `packages/crew/`, re-spell them relative to `packages/crew`;
//   2. none left (docs, root files, another workspace) → print why and exit 0 — nothing to run;
//   3. else `npx vitest related --run --passWithNoTests <files>` with `cwd: packages/crew`, and exit
//      with vitest's status (`--passWithNoTests`: a crew source file with no related test is not a
//      failure of the change).
//
// `--dry-run` prints the plan as JSON instead of running it (what the unit test asserts).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREW = 'packages/crew';

/** Worktree-root-relative paths → the ones under packages/crew, spelled relative to it. */
export function crewRelative(files) {
  const out = [];
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.startsWith(`${CREW}/`)) out.push(norm.slice(CREW.length + 1));
  }
  return out;
}

/** The plan: `{ skip: reason }` when nothing under packages/crew changed, else `{ argv, cwd }`. */
export function plan(files) {
  const related = crewRelative(files);
  if (related.length === 0) return { skip: 'no crew files touched — no related tests to run (docs / root / other-workspace change)' };
  return {
    argv: ['npx', 'vitest', 'related', '--run', '--passWithNoTests', ...related],
    cwd: CREW,
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  const files = dryRun ? args.slice(1) : args;
  const p = plan(files);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(p)}\n`);
    process.exit(0);
  }
  if (p.skip) {
    process.stdout.write(`test-related: ${p.skip}\n`);
    process.exit(0);
  }
  process.stdout.write(`test-related: ${p.argv.join(' ')} (cwd ${p.cwd})\n`);
  const [cmd, ...rest] = p.argv;
  const r = spawnSync(process.platform === 'win32' ? `${cmd}.cmd` : cmd, rest, {
    cwd: resolve(ROOT, p.cwd),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.error) {
    process.stderr.write(`test-related: could not run vitest: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
