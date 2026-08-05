#!/usr/bin/env node
/**
 * Make the sibling `wicked-core` checkout that crew's cross-repo drift guards read exist.
 *
 * # Why (FINDING-094)
 *
 * Crew's guards derive core's constants from core's own artifacts instead of transcribing them —
 * that is the whole point of them (FINDING-049, -084, -088). So a sibling wicked-core checkout is a
 * real prerequisite of crew's test suite, and every environment that runs those tests has to meet
 * it. Crew's CI does, by checking both repos out as siblings. The RELEASE pipeline did not: it
 * calls `wicked-ci/node-release.yml`, whose test job is a bare single-repo checkout. On the `v0.4.0`
 * tag one guard hard-failed and blocked the publish while two others silently skipped.
 *
 * Rather than teach three tests to cope with an environment that is missing something, this makes
 * the environment stop being missing it. `packages/crew/tests/support/core-checkout.ts` holds the
 * matching resolver and the policy for the case where this script was never run.
 *
 * # Behaviour
 *
 * Idempotent and non-destructive. If a usable checkout is already at the destination — which on a
 * developer machine is their real working copy — this does nothing and touches nothing. It NEVER
 * deletes: a directory that exists but is not a usable checkout is reported, not removed, because
 * the destination on a developer machine is a working tree with uncommitted work in it.
 *
 * Cross-platform per CLAUDE.md: node rather than shell, `node:path` rather than path strings, and
 * no shell builtins — `setup-node` runs before the install step in every workflow that calls this,
 * so the runtime is guaranteed.
 *
 *   node scripts/fetch-core-checkout.mjs
 *   WICKED_CORE_DIR=/path/to/wicked-core node scripts/fetch-core-checkout.mjs   # use this instead
 *   WICKED_CORE_REF=some-branch node scripts/fetch-core-checkout.mjs            # default: main
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEST = process.env['WICKED_CORE_DIR'] ?? resolve(REPO_ROOT, '..', 'wicked-core');
/** `main` matches crew's CI (`WICKED_CORE_REF`), deliberately: the release must gate on the same
 *  revision of core that every PR was checked against, or the two disagree about what "green" is. */
const REF = process.env['WICKED_CORE_REF'] ?? 'main';
const URL = process.env['WICKED_CORE_URL'] ?? 'https://github.com/mikeparcewski/wicked-core.git';

/** The same list `tests/support/core-checkout.ts` requires — a clone that exits 0 without these is
 *  not a success, it is a layout change wearing a success's clothes. */
const REQUIRED_ARTIFACTS = [
  join('workflows', 'domain-extraction.json'),
  join('crates', 'wicked-core-ts', 'package.json'),
];

const missing = (dir) => REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(dir, rel)));

function die(message) {
  console.error(`fetch-core-checkout: ${message}`);
  process.exit(1);
}

if (existsSync(DEST)) {
  const gaps = missing(DEST);
  if (gaps.length === 0) {
    console.log(`  wicked-core checkout already usable at ${DEST}`);
    process.exit(0);
  }
  die(
    `${DEST} exists but is missing ${gaps.join(', ')}.\n` +
      '  Refusing to delete it — on a developer machine this is a working tree with real work in\n' +
      '  it. Repair or remove it by hand, or point WICKED_CORE_DIR somewhere else.',
  );
}

console.log(`  cloning ${URL} @ ${REF} -> ${DEST}`);
const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', REF, URL, DEST], {
  stdio: 'inherit',
});
if (clone.error) die(`could not run git: ${clone.error.message}`);
if (clone.status !== 0) die(`git clone exited ${clone.status}`);

// Exit code is not evidence the artifacts arrived. Check the thing that is actually needed —
// a clone can succeed against a repo that has since moved these files, and the failure would
// otherwise surface three tests later as an unexplained ENOENT.
const gaps = missing(DEST);
if (gaps.length > 0) {
  die(
    `cloned ${URL}@${REF} but ${gaps.join(', ')} is not in it.\n` +
      "  wicked-core's layout changed. Update REQUIRED_ARTIFACTS here and in\n" +
      '  packages/crew/tests/support/core-checkout.ts, and the guards that read them.',
  );
}
console.log(`  ok — ${DEST}`);
