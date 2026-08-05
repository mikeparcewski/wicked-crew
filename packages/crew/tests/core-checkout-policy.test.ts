// FINDING-094/095 regression: the cross-repo guards must actually RUN in every automated
// environment, and there must be exactly one way to find the checkout they need.
//
// # What happened
//
// Crew's guards derive core's constants from core's own artifacts, which makes a sibling
// wicked-core checkout a prerequisite of the suite. Crew's CI provides it; the release pipeline —
// a bare single-repo checkout via `wicked-ci/node-release.yml` — did not. Five resolvers across
// four files had grown up around that prerequisite with three different absence policies, so on
// the `v0.4.0` tag the release simultaneously:
//
//   · hard-failed on `armed-workflow-served.test.ts`, blocking the publish, and
//   · silently skipped `builtin-overlay-shadow.test.ts` (the five mirrors crew actually writes)
//     and `engine-range-admits-built.test.ts` (whether the range being frozen into the published
//     artifact can install the engine it was tested against).
//
// The blocked publish was visible. The two vacated guards were not — they reported as passing.
//
// # What these tests hold
//
// The first is the direct regression test: in any environment that has not explicitly opted out,
// the guards must not be in skip mode. If the release workflow ever stops providing the checkout,
// this fails there rather than the suite quietly shrinking.
//
// The second is the P3-family audit this codebase uses elsewhere (`spawn_audit` in wicked-core,
// the `ElicitationPrompt` mount audit in studio): one hardened path, and a test that fails the
// build when a new bypass appears.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_CHECKS_OPTIONAL,
  CORE_DIR,
  SKIP_CORE_CHECKS,
  coreDirMissingMessage,
  resolveCoreDir,
} from './support/core-checkout.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

describe('the cross-repo guards are live in this environment', () => {
  /// THE regression test for the release failure.
  ///
  /// Skipped only under the explicit human opt-out, which no workflow sets — so in CI and in the
  /// release job this is unconditional. A run where the sibling checkout is missing now fails HERE,
  /// naming the cause, instead of one guard exploding and two others reporting green.
  it.skipIf(CORE_CHECKS_OPTIONAL)('is not running in skip mode', () => {
    expect(
      SKIP_CORE_CHECKS,
      'the cross-repo drift guards are in skip mode. Automation must never reach this state: ' +
        'these guards decide whether crew serves the pin core approved and whether the declared ' +
        'engine range can install the engine we tested against.\n' +
        coreDirMissingMessage(),
    ).toBe(false);
    expect(CORE_DIR, 'no wicked-core checkout resolved').not.toBeNull();
  });

  /// Presence of a path string is not presence of a checkout. Assert the artifacts the guards
  /// actually read, so a directory that merely has the right NAME cannot satisfy this.
  it.skipIf(CORE_CHECKS_OPTIONAL)('resolved a checkout that carries the artifacts', () => {
    const dir = resolveCoreDir();
    expect(dir).not.toBeNull();
    for (const rel of [
      join('workflows', 'domain-extraction.json'),
      join('crates', 'wicked-core-ts', 'package.json'),
    ]) {
      expect(statSync(join(dir!, rel)).isFile(), `${rel} missing from ${dir}`).toBe(true);
    }
  });

  /// The failure message has to be actionable — the whole reason the old spellings were tolerable
  /// is that nobody could tell from the output what the environment was missing.
  it('tells an operator how to satisfy the prerequisite', () => {
    const msg = coreDirMissingMessage();
    expect(msg).toContain('fetch-core-checkout.mjs');
    expect(msg).toContain('WICKED_CORE_DIR');
    expect(msg).toContain('WICKED_CORE_OPTIONAL');
  });
});

describe('one resolver, one policy', () => {
  /// Built by concatenation so this file does not match its own audit — the alternative is
  /// excluding this file from the scan, which would make the audit unable to see a bypass added
  /// here.
  ///
  /// Quote characters only, NOT backticks: prose in these files refers to the sibling checkout as
  /// `wicked-core` in markdown, and an audit that fires on comments is one people learn to work
  /// around. A path segment in code is quoted; `'wicked-core-ts'` does not match because the
  /// closing quote is not adjacent.
  const QUOTED_SEGMENT = new RegExp(`['"]wicked` + `-core['"]`);
  const CORE_ENV = /WICKED_CORE_(DIR|OPTIONAL)/;

  /** Every .ts under tests/, except the one module allowed to know these things. */
  function testFiles(): string[] {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    return walk(TESTS_DIR).filter((f) => f !== join(TESTS_DIR, 'support', 'core-checkout.ts'));
  }

  it('no test file resolves the wicked-core checkout for itself', () => {
    const offenders = testFiles().filter((f) => QUOTED_SEGMENT.test(readFileSync(f, 'utf8')));
    expect(
      offenders.map((f) => relative(TESTS_DIR, f)),
      'these files spell the sibling checkout path themselves. Five such spellings with three ' +
        'different absence policies is what produced FINDING-094 — import from ' +
        'tests/support/core-checkout.ts instead.',
    ).toEqual([]);
  });

  it('no test file reads the checkout env vars for itself', () => {
    const offenders = testFiles().filter((f) => CORE_ENV.test(readFileSync(f, 'utf8')));
    expect(
      offenders.map((f) => relative(TESTS_DIR, f)),
      'the absence policy is one decision and belongs in one module; a second reader of these ' +
        'env vars is a second policy.',
    ).toEqual([join('core-checkout-policy.test.ts')]);
  });
});
