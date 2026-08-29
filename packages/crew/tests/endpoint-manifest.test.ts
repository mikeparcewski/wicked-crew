/**
 * TH-11 — the committed endpoint manifest matches the LIVE route table, or this fails.
 *
 * `endpoint-manifest.json` (package root, committed) is the machine-readable record of every
 * method+path the daemon serves, with request/response type names and status codes where routes
 * declare them (`config.manifest`). It is generated from the same `onRoute` hook the served
 * daemon runs (src/api/endpoint-manifest.ts), so the ONLY way it can disagree with this test —
 * which rebuilds the live table through the identical assembly — is that a route changed after
 * the last `npm run manifest:endpoints`. That is the point: an added, removed, renamed, or
 * re-declared endpoint fails CI here until the manifest is regenerated and its diff is reviewed
 * alongside the route change. The manifest diff IS the API regression trigger.
 *
 * On failure: `npm run manifest:endpoints -w packages/crew`, review the JSON diff, commit both.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { collectLiveEndpointManifest } from '../src/api/endpoint-manifest-live.js';
import { apiTypesVersion, type EndpointManifest } from '../src/api/endpoint-manifest.js';

const MANIFEST_PATH = fileURLToPath(new URL('../endpoint-manifest.json', import.meta.url));

function committed(): EndpointManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as EndpointManifest;
}

describe('endpoint-manifest.json (TH-11)', () => {
  it('matches the live route table exactly — drift fails CI until regenerated + reviewed', async () => {
    const live = await collectLiveEndpointManifest();
    // toEqual over the whole artifact: any endpoint added/removed/renamed, any declaration
    // change, any api-types bump shows up as a structural diff naming the exact row.
    expect(
      live,
      'endpoint-manifest.json is stale — run `npm run manifest:endpoints -w packages/crew`, review the diff, and commit it with the route change',
    ).toEqual(committed());
  });

  it('carries the wire-contract version of the installed wicked-crew-api-types', () => {
    expect(committed().apiTypesVersion).toBe(apiTypesVersion());
  });

  it('records the declared run-lifecycle bindings (the config.manifest channel works)', () => {
    const byKey = new Map(committed().endpoints.map((e) => [`${e.method} ${e.path}`, e]));
    const launch = byKey.get('POST /api/v1/runs');
    expect(launch?.requestType).toBe('LaunchRunBody');
    expect(launch?.statusCodes).toEqual([201, 400, 404, 409]);
    const gate = byKey.get('POST /api/v1/runs/:id/gate');
    expect(gate?.requestType).toBe('GateDecision');
    expect(gate?.statusCodes).toEqual([200, 400, 404, 409]);
    const guidance = byKey.get('PUT /api/v1/runs/:id/guidance');
    expect(guidance?.requestType).toBe('SetGuidanceBody');
    expect(guidance?.responseType).toBe('SetGuidanceResult');
  });

  it('covers the whole served surface, without fastify HEAD-twin noise', () => {
    const m = committed();
    // The daemon serves a large API; a manifest that suddenly shrinks to a handful of rows means
    // the collector booted the wrong assembly (e.g. routes registered before the hook).
    expect(m.endpoints.length).toBeGreaterThan(60);
    expect(m.endpoints.some((e) => e.method === 'HEAD')).toBe(false);
    // The WS surface is part of the contract too.
    expect(m.endpoints.filter((e) => e.websocket === true).map((e) => e.path)).toEqual([
      '/ws',
      '/ws/terminals/:id',
    ]);
    // Stable ordering — what makes drift diffs reviewable.
    const keys = m.endpoints.map((e) => `${e.path} ${e.method}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});
