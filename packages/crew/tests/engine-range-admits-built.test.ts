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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_MANIFEST = join(HERE, '..', 'package.json');

const CORE_DIR =
  process.env['WICKED_CORE_DIR'] ?? join(HERE, '..', '..', '..', '..', 'wicked-core');
const CORE_TS_MANIFEST = join(CORE_DIR, 'crates', 'wicked-core-ts', 'package.json');

function declaredRange(): string {
  const m = JSON.parse(readFileSync(CREW_MANIFEST, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = m.dependencies?.['wicked-core-ts'];
  if (range === undefined) throw new Error('crew no longer declares a wicked-core-ts dependency');
  return range;
}

/** Does `^X.Y.Z` admit `version`? Implements npm's caret rule for 0.x, which is the case that bit
 *  us: below 1.0.0 a caret pins the MINOR, so `^0.3.0` excludes 0.4.0. */
function caretAdmits(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (m === null) throw new Error(`unsupported range shape "${range}" — extend this guard`);
  const [rMaj, rMin, rPat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (v === null) throw new Error(`unparseable version "${version}"`);
  const [vMaj, vMin, vPat] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (vMaj !== rMaj) return false;
  // Below 1.0.0 the minor is the breaking axis, so it must match exactly.
  if (rMaj === 0) return vMin === rMin && vPat >= rPat;
  return vMin > rMin || (vMin === rMin && vPat >= rPat);
}

describe('the declared engine range admits the engine we build against', () => {
  /// Pins the caret semantics the defect turned on, so the comparison above cannot quietly rot
  /// into "any 0.x matches".
  it('models npm caret semantics, including the 0.x minor pin', () => {
    expect(caretAdmits('^0.3.0', '0.4.0'), '^0.3.0 must NOT admit 0.4.0 — this is the defect').toBe(
      false,
    );
    expect(caretAdmits('^0.4.0', '0.4.0')).toBe(true);
    expect(caretAdmits('^0.4.0', '0.4.7')).toBe(true);
    expect(caretAdmits('^0.4.0', '0.5.0')).toBe(false);
    expect(caretAdmits('^1.2.0', '1.9.0')).toBe(true);
  });

  /// THE invariant. Skipped, not failed, when the sibling checkout is absent — crew's suite must
  /// stay runnable standalone — but CI checks core out, so it runs there.
  it.skipIf(!existsSync(CORE_TS_MANIFEST))(
    'the range in crew/package.json admits the version in wicked-core/crates/wicked-core-ts',
    () => {
      const built = (JSON.parse(readFileSync(CORE_TS_MANIFEST, 'utf8')) as { version: string })
        .version;
      const range = declaredRange();
      expect(
        caretAdmits(range, built),
        `crew declares wicked-core-ts "${range}", which cannot install the ${built} engine this ` +
          `code is built and tested against. An operator installing from npm gets a different ` +
          `engine than CI proved green.`,
      ).toBe(true);
    },
  );
});
