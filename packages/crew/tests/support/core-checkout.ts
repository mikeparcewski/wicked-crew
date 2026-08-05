// The ONE place that knows where the sibling `wicked-core` checkout lives, and the ONE policy for
// what happens when it is not there.
//
// # The defect this exists to end (FINDING-094)
//
// Crew's cross-repo drift guards read wicked-core's shipped workflow JSON and its core-ts manifest.
// They do that deliberately: transcribing core's constants into crew's tests is the drift this
// ecosystem keeps paying for (FINDING-049, -084, -088), so the guards derive rather than duplicate.
// That makes "a sibling wicked-core checkout" a genuine prerequisite of crew's test suite.
//
// It was never declared as one, and four files each invented their own spelling:
//
//   tests/armed-workflow-served.test.ts      two candidate paths, no env override, THREW on absence
//   tests/engine-range-admits-built.test.ts  WICKED_CORE_DIR + one path, `it.skipIf` on absence
//   tests/builtin-overlay-shadow.test.ts     WICKED_CORE_DIR + one path, `describe.skipIf`
//   scripts/use-local-core-ts.mjs            WICKED_CORE_TS_DIR + one path, dies on absence
//
// Three absence policies for one prerequisite. The release pipeline
// (`wicked-ci/node-release.yml`) does a bare single-repo checkout, unlike crew's own CI which
// checks crew and core out as true siblings — so on the `v0.4.0` tag the first of those hard-failed
// and blocked the release, while the other two silently skipped. The release gate blocked on one
// cross-repo check and lost two others in the same run, and said so about only one of them.
//
// # The policy
//
// **Absence is a failure, not a skip.** A guard that quietly vacates in the environment where its
// answer decides whether to publish is worse than no guard at all: it reports green.
//
// The prerequisite is satisfiable everywhere — `scripts/fetch-core-checkout.mjs` creates it, and
// the release workflow runs it as part of its install step. The single exception is a human running
// crew's suite standalone with no network, who may set `WICKED_CORE_OPTIONAL=1` to downgrade these
// guards to skips. Automation must never set it; `tests/core-checkout-policy.test.ts` fails if an
// automated environment ever loses the checkout, which is the regression test for the above.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/packages/crew`. Anchoring on the package root keeps the `..` count from drifting as
 *  this file moves; every path below is expressed relative to a named anchor, not counted out. */
const PKG_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

/**
 * The artifacts the guards actually read. A directory qualifies as core's checkout only if it has
 * ALL of them.
 *
 * Checking for the files rather than for the directory is the difference between "something is
 * named wicked-core here" and "the thing the guards need is here" — a shallow, partial, or
 * half-deleted checkout satisfies the first and fails the second at the point of use, with a
 * `readFileSync` stack trace instead of a diagnosis.
 */
const REQUIRED_ARTIFACTS: readonly string[] = [
  join('workflows', 'domain-extraction.json'),
  join('crates', 'wicked-core-ts', 'package.json'),
];

/**
 * Where core may be.
 *
 * `WICKED_CORE_DIR`, when set, is the ONLY candidate — it is not the head of a list. An explicit
 * override that silently falls through to a different checkout answers a question about a checkout
 * the caller did not choose, which is how a targeted run ends up reporting on the sibling it was
 * pointed away from. If it is set and unusable, that is an error, not a reason to look elsewhere.
 *
 * Otherwise, both real automatic layouts are satisfied by the first expression:
 *   local dev   `~/Projects/wicked/{wicked-crew,wicked-core}`
 *   crew CI     crew at `$GITHUB_WORKSPACE/wicked-crew`, core at `$GITHUB_WORKSPACE/wicked-core`
 *   release     crew at `$GITHUB_WORKSPACE`, core cloned to `$GITHUB_WORKSPACE/../wicked-core`
 * The second is kept for the nested layout the old resolver also accepted.
 */
const OVERRIDE: string | undefined = process.env['WICKED_CORE_DIR'];
const CANDIDATES: readonly string[] =
  OVERRIDE !== undefined && OVERRIDE.length > 0
    ? [OVERRIDE]
    : [resolve(REPO_ROOT, '..', 'wicked-core'), resolve(REPO_ROOT, '..', '..', 'wicked-core')];

function missingArtifacts(dir: string): string[] {
  return REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(dir, rel)));
}

/** The resolved checkout, or `null`. Exported as a function so the policy test can re-run it. */
export function resolveCoreDir(): string | null {
  for (const dir of CANDIDATES) {
    if (existsSync(dir) && missingArtifacts(dir).length === 0) return dir;
  }
  return null;
}

export const CORE_DIR: string | null = resolveCoreDir();

/** Explicit human opt-out. Automation never sets this — see the policy note above. */
export const CORE_CHECKS_OPTIONAL: boolean = process.env['WICKED_CORE_OPTIONAL'] === '1';

/**
 * Whether the cross-repo guards may skip.
 *
 * Note the conjunction: a missing checkout alone is NOT sufficient. Without the explicit opt-out a
 * missing checkout is a hard failure, which is what stops an automated environment from silently
 * dropping these checks.
 */
export const SKIP_CORE_CHECKS: boolean = CORE_DIR === null && CORE_CHECKS_OPTIONAL;

/** What to tell someone whose environment cannot satisfy the prerequisite. */
export function coreDirMissingMessage(): string {
  const brokenCandidates = CANDIDATES.filter((d) => existsSync(d)).map(
    (d) => `    ${d}  (missing: ${missingArtifacts(d).join(', ')})`,
  );
  return [
    "crew's cross-repo drift guards need a sibling wicked-core checkout, and none was found.",
    OVERRIDE !== undefined && OVERRIDE.length > 0
      ? '  WICKED_CORE_DIR is set, so it is the only place checked — an explicit override is not a' +
        '\n  hint, and falling back to a different checkout would answer about the wrong one:'
      : '  Looked in:',
    ...CANDIDATES.map((c) => `    ${c}`),
    ...(brokenCandidates.length > 0
      ? ['  These exist but are not usable checkouts:', ...brokenCandidates]
      : []),
    '  Fix: `node scripts/fetch-core-checkout.mjs`, which CI and the release workflow both run,',
    '  or point WICKED_CORE_DIR at an existing checkout.',
    '  To run crew standalone without the cross-repo guards, set WICKED_CORE_OPTIONAL=1. Automation',
    '  must not: a guard that skips where the result decides whether to publish reports green',
    '  without having checked anything.',
  ].join('\n');
}

/** The checkout, or a failure that says what to do about it. */
export function requireCoreDir(): string {
  if (CORE_DIR !== null) return CORE_DIR;
  throw new Error(coreDirMissingMessage());
}

/** Read and parse one of core's shipped JSON artifacts. */
export function readCoreJson<T>(...relativeParts: string[]): T {
  const path = join(requireCoreDir(), ...relativeParts);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    // A raw ENOENT or SyntaxError here names the file but not the reason it matters. These reads
    // are cross-repo contract points; when one breaks, the reader needs to know that.
    throw new Error(
      `cannot read core's ${relativeParts.join('/')} at ${path}: ` +
        `${e instanceof Error ? e.message : String(e)}\n` +
        '  This is a cross-repo contract artifact. If wicked-core moved or renamed it, update ' +
        'REQUIRED_ARTIFACTS and the guard that reads it rather than deleting the guard.',
    );
  }
}
