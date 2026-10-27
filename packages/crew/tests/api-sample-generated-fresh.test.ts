/**
 * crew#1169 — the committed generated API suite matches what its generator writes, or this fails.
 *
 * `tests/generated/api-sample.generated.test.ts` is generated from `endpoint-manifest.json` and
 * committed. The governed deliver step re-runs `npm run generate:api-tests` before it pushes
 * (crew#426) and refuses when that changes the tree the engine verified. A stale committed copy
 * (it sat at "221 endpoints, api-types 0.120.0" from #1018 until #1169) therefore made EVERY
 * governed crew delivery refuse once and pay a full re-verify. The manifest itself is pinned by
 * tests/endpoint-manifest.test.ts; this pins the suite derived from it.
 *
 * On failure: `npm run generate:api-tests -w packages/crew` and commit the result.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  API_SAMPLE_SUITE_PATH,
  committedManifest,
  renderApiSampleSuite,
} from '../scripts/generate-api-tests.js';

describe('generated API suite freshness (crew#1169)', () => {
  it('the committed api-sample suite is what the generator writes from the committed manifest', () => {
    expect(
      readFileSync(API_SAMPLE_SUITE_PATH, 'utf8'),
      'tests/generated/api-sample.generated.test.ts is stale — run `npm run generate:api-tests -w packages/crew` and commit it',
    ).toBe(renderApiSampleSuite(committedManifest()));
  });

  it('names the manifest it was generated from in its header', () => {
    const m = committedManifest();
    expect(readFileSync(API_SAMPLE_SUITE_PATH, 'utf8')).toContain(
      `Manifest: ${m.endpoints.length} endpoints, wicked-crew-api-types ${m.apiTypesVersion}.`,
    );
  });

  it('a stale header is caught (the #1018..#1169 drift)', () => {
    const m = committedManifest();
    const stale = { ...m, apiTypesVersion: '0.120.0' };
    expect(renderApiSampleSuite(stale)).toContain('wicked-crew-api-types 0.120.0.');
    expect(renderApiSampleSuite(stale)).not.toBe(renderApiSampleSuite(m));
  });
});
