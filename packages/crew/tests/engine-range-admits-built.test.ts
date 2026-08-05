// FINDING-088: crew's DECLARED engine range could not install the engine its code targets.
//
// `packages/crew/package.json` declared `"wicked-core-ts": "^0.3.0"`. For a 0.x package that means
// `>=0.3.0 <0.4.0`, so the range CANNOT install 0.4.0 — and 0.4.0 is what the code is written
// against and what CI tests. Neither local dev nor CI could observe it: both build wicked-core-ts
// from source and link it in (FINDING-072's fix), so both ran 0.4.0 regardless of the manifest.
// Only an operator running `npm i wicked-crew` resolved the declared range, and got 0.3.0.
//
// Measured API gap (published .d.ts, 0.3.0 -> 0.4.0): 31 -> 35 methods. Absent from 0.3.0:
// `chatList`, `retireConformanceRule`, `retirePolicy`, `runEvents`.
//
// This is FINDING-081's family — the artifact that RUNS is not the artifact that was BUILT — and
// the reason it survived is the reason that family keeps recurring: two artifacts had to agree and
// nothing compared them. So compare them.
//
// The guard reads BOTH sides at test time rather than restating either: the declared range from
// crew's manifest, the engine version from wicked-core's own crate. A hardcoded expected version
// here would be a third copy, which is the defect, not the fix.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from 'semver';
import { SKIP_CORE_CHECKS, readCoreJson } from './support/core-checkout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_MANIFEST = join(HERE, '..', 'package.json');

/** Core's built engine version, or `null` under the explicit standalone opt-out (FINDING-094). */
const builtEngineVersion: string | null = SKIP_CORE_CHECKS
  ? null
  : readCoreJson<{ version: string }>('crates', 'wicked-core-ts', 'package.json').version;

function declaredRange(): string {
  const m = JSON.parse(readFileSync(CREW_MANIFEST, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = m.dependencies?.['wicked-core-ts'];
  if (range === undefined) throw new Error('crew no longer declares a wicked-core-ts dependency');
  return range;
}

/** Would npm install `version` given `range`?
 *
 *  This delegates to `semver` rather than modelling the rules, and that is the point. The first
 *  cut of this guard hand-rolled the caret logic and review found two ways it was wrong: it read
 *  `^0.0.3` as `>=0.0.3` (npm pins the patch — the left-most non-zero element is the breaking
 *  axis, so it means `=0.0.3`), and it let `0.4.0-beta.1` count as `0.4.0`. Both would have made
 *  the guard PASS for versions npm refuses to install.
 *
 *  A guard that is believed and wrong is worse than no guard — and a second copy of someone
 *  else's semantics is exactly the drift this whole finding is about. So: no second copy. */
function admits(range: string, version: string): boolean {
  return satisfies(version, range);
}

describe('the declared engine range admits the engine we build against', () => {
  /// Pins the caret semantics the defect turned on, so the comparison above cannot quietly rot
  /// into "any 0.x matches".
  it('models npm caret semantics, including the 0.x minor pin', () => {
    expect(admits('^0.3.0', '0.4.0'), '^0.3.0 must NOT admit 0.4.0 — this is the defect').toBe(
      false,
    );
    expect(admits('^0.4.0', '0.4.0')).toBe(true);
    expect(admits('^0.4.0', '0.4.7')).toBe(true);
    expect(admits('^0.4.0', '0.5.0')).toBe(false);
    expect(admits('^0.4.1', '0.4.0')).toBe(false);
    expect(admits('^1.2.0', '1.9.0')).toBe(true);
    expect(admits('^1.2.0', '2.0.0')).toBe(false);
  });

  /// `^0.0.Z` pins the PATCH — the left-most non-zero element is the patch, so it is effectively
  /// `=0.0.Z`. Modelling it as `>=0.0.Z` would make the guard pass for a version npm refuses.
  it('pins the patch for ^0.0.x', () => {
    expect(admits('^0.0.3', '0.0.3')).toBe(true);
    expect(admits('^0.0.3', '0.0.4'), '^0.0.3 means =0.0.3, not >=0.0.3').toBe(false);
    expect(admits('^0.0.3', '0.1.0')).toBe(false);
  });

  /// A prerelease must not be counted as its release. `0.4.0-beta.1` is NOT `0.4.0`, and a naive
  /// parser that ignores the suffix would admit a build npm would not install.
  it('does not let a prerelease satisfy a release range', () => {
    expect(admits('^0.4.0', '0.4.0-beta.1')).toBe(false);
    expect(admits('^0.4.0', '0.4.1-rc.0')).toBe(false);
    // A prerelease RANGE admits its own line, which is semver's rule, not one we invent.
    expect(admits('^0.4.0-beta.1', '0.4.0')).toBe(true);
    expect(admits('^0.4.0-beta.1', '0.4.0-beta.2')).toBe(true);
    expect(admits('^0.4.0-beta.2', '0.4.0-beta.1')).toBe(false);
  });

  /// THE invariant.
  ///
  /// This used to skip whenever the sibling checkout was missing, on the reasoning that crew's
  /// suite must stay runnable standalone. That reasoning was right about developers and wrong about
  /// automation: the RELEASE job has no sibling checkout either, so this check — the one that
  /// decides whether the range being frozen into a published artifact can install the engine it was
  /// tested against — silently vacated in the exact run where it mattered most (FINDING-094/095).
  /// Now it skips only under an explicit human opt-out that automation never sets.
  it.skipIf(SKIP_CORE_CHECKS)(
    'the range in crew/package.json admits the version in wicked-core/crates/wicked-core-ts',
    () => {
      const built = builtEngineVersion!;
      const range = declaredRange();
      expect(
        admits(range, built),
        `crew declares wicked-core-ts "${range}", which cannot install the ${built} engine this ` +
          `code is built and tested against. An operator installing from npm gets a different ` +
          `engine than CI proved green.`,
      ).toBe(true);
    },
  );
});
