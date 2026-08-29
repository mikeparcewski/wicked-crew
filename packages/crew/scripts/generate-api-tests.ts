/**
 * Derive API tests from the committed endpoint manifest (TH-11).
 *
 *   npm run generate:api-tests -w packages/crew
 *
 * Reads `endpoint-manifest.json` and emits `tests/generated/api-sample.generated.test.ts` — a
 * vitest suite of positive + negative cases per sampled endpoint. WHICH negative cases exist is
 * derived from the manifest, never hand-picked:
 *
 *   - 400: the manifest declares 400 and the method carries a body → inject a body every
 *          `.strict()` zod schema must refuse (`{ __unexpected_field__: true }`).
 *   - 404: the manifest declares 404 and the path has `:params` → substitute ids that exist
 *          nowhere (`no-such-<param>`), with the sample's valid body so the parse step passes
 *          and the lookup is what answers.
 *   - 409: the manifest declares 409 → a real case when the sample names the conflicting state
 *          (fixture ids from tests/generated/harness.ts), an explicit `it.todo` when the
 *          conflict needs state no fixture provides yet — declared codes are never silently
 *          dropped.
 *
 * The SAMPLES table below is the only hand-maintained part: per endpoint, the data values a
 * manifest cannot know (a valid body, which fixture run conflicts). Endpoints are sampled — the
 * point is a generator that scales with the manifest, not hundreds of hand-written tests.
 * Adding a row + regenerating is the whole cost of covering another endpoint.
 *
 * The emitted file is committed and runs in the normal suite. Regenerate after route changes;
 * the endpoint-manifest drift test is what tells you the manifest (and therefore this suite's
 * inputs) went stale.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EndpointEntry, EndpointManifest } from '../src/api/endpoint-manifest.js';

interface Sample {
  method: string;
  path: string;
  /** Expected success case: status + (for body methods) a valid body. Omit to skip positives. */
  positive?: { status: number; body?: unknown; params?: Record<string, string> };
  /** A body that passes schema validation — used by 404/409 negatives on body-carrying routes. */
  validBody?: unknown;
  /** The 409 case: params naming a fixture resource in the conflicting state. */
  conflict?: { params: Record<string, string> };
}

/** Fixture ids — MUST match tests/generated/harness.ts exports. */
const RUN_DONE = 'run-fixture-done';
const RUN_GATED = 'run-fixture-gated';

const SAMPLES: Sample[] = [
  { method: 'GET', path: '/api/v1/health', positive: { status: 200 } },
  { method: 'GET', path: '/api/v1/runs', positive: { status: 200 } },
  {
    method: 'GET',
    path: '/api/v1/runs/:id',
    positive: { status: 200, params: { id: RUN_DONE } },
  },
  {
    method: 'POST',
    path: '/api/v1/runs',
    positive: { status: 201, body: { problem: 'generated-suite smoke launch' } },
    validBody: { problem: 'generated-suite smoke launch' },
  },
  {
    method: 'POST',
    path: '/api/v1/runs/:id/gate',
    positive: { status: 200, params: { id: RUN_GATED }, body: { approve: true } },
    validBody: { approve: true },
    // A completed run is not awaiting a human gate — the route's declared 409.
    conflict: { params: { id: RUN_DONE } },
  },
  {
    method: 'PUT',
    path: '/api/v1/runs/:id/guidance',
    positive: { status: 200, params: { id: RUN_DONE }, body: { text: 'generated note' } },
    validBody: { text: 'generated note' },
  },
];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const manifestPath = fileURLToPath(new URL('../endpoint-manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EndpointManifest;
const byKey = new Map(manifest.endpoints.map((e) => [`${e.method} ${e.path}`, e]));

function entryOf(s: Sample): EndpointEntry {
  const entry = byKey.get(`${s.method} ${s.path}`);
  if (entry === undefined) {
    // A sampled endpoint that left the manifest is a REAL finding — the sample table is stale
    // (or the route was removed). Refusing beats emitting a suite that silently covers less.
    throw new Error(
      `sample ${s.method} ${s.path} is not in endpoint-manifest.json — regenerate the manifest ` +
        `(npm run manifest:endpoints) and update the SAMPLES table`,
    );
  }
  return entry;
}

function substituted(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`no param value for :${name} in ${path}`);
    return v;
  });
}

function notFoundPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => `no-such-${name}`);
}

const q = (s: string): string => JSON.stringify(s);

function injectCall(method: string, url: string, body: unknown | undefined): string {
  const payload = body === undefined ? '' : `, payload: ${JSON.stringify(body)}`;
  return `await app.inject({ method: ${q(method)}, url: ${q(url)}${payload} })`;
}

const blocks: string[] = [];
for (const s of SAMPLES) {
  const entry = entryOf(s);
  const cases: string[] = [];

  if (s.positive !== undefined) {
    const url = s.positive.params !== undefined ? substituted(s.path, s.positive.params) : s.path;
    const codes = entry.statusCodes;
    const tie =
      codes.length > 0
        ? `\n      // The manifest declares this route's codes — the positive must be one of them.\n      expect(${JSON.stringify(codes)}).toContain(res.statusCode);`
        : '';
    cases.push(`    it('${s.method} ${s.path} — positive (${s.positive.status})', async () => {
      const res = ${injectCall(s.method, url, s.positive.body)};
      expect(res.statusCode).toBe(${s.positive.status});${tie}
    });`);
  }

  if (entry.statusCodes.includes(400) && BODY_METHODS.has(s.method)) {
    cases.push(`    it('${s.method} ${s.path} — 400 on a body the schema refuses', async () => {
      const res = ${injectCall(s.method, s.positive?.params !== undefined ? substituted(s.path, s.positive.params) : s.path, { __unexpected_field__: true })};
      expect(res.statusCode).toBe(400);
    });`);
  }

  if (entry.statusCodes.includes(404)) {
    if (s.path.includes(':')) {
      cases.push(`    it('${s.method} ${s.path} — 404 for a resource that exists nowhere', async () => {
      const res = ${injectCall(s.method, notFoundPath(s.path), BODY_METHODS.has(s.method) ? s.validBody : undefined)};
      expect(res.statusCode).toBe(404);
    });`);
    } else {
      // Declared codes are never silently dropped: a 404 with no path param comes from the
      // BODY naming a missing resource (e.g. POST /runs with an unknown projectId) — state a
      // fixture hint has to provide.
      cases.push(
        `    it.todo('${s.method} ${s.path} — 404 is declared but body-driven (add a fixture hint to SAMPLES)');`,
      );
    }
  }

  if (entry.statusCodes.includes(409)) {
    if (s.conflict !== undefined) {
      cases.push(`    it('${s.method} ${s.path} — 409 in the conflicting state', async () => {
      const res = ${injectCall(s.method, substituted(s.path, s.conflict.params), s.validBody)};
      expect(res.statusCode).toBe(409);
    });`);
    } else {
      cases.push(
        `    it.todo('${s.method} ${s.path} — 409 is declared but needs state no fixture provides yet (add a conflict hint to SAMPLES)');`,
      );
    }
  }

  blocks.push(`  describe('${s.method} ${s.path}', () => {\n${cases.join('\n\n')}\n  });`);
}

const out = `/**
 * GENERATED by scripts/generate-api-tests.ts from endpoint-manifest.json — DO NOT EDIT.
 * Regenerate: npm run generate:api-tests -w packages/crew
 *
 * Manifest: ${manifest.endpoints.length} endpoints, wicked-crew-api-types ${manifest.apiTypesVersion}.
 * Sampled: ${SAMPLES.length} endpoints; negative cases (400/404/409) derived from each route's
 * declared statusCodes. Fixture state comes from ./harness.ts (hand-written).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildGeneratedApiApp } from './harness.js';

describe('generated API suite (endpoint-manifest sample)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildGeneratedApiApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

${blocks.join('\n\n')}
});
`;

const outPath = fileURLToPath(new URL('../tests/generated/api-sample.generated.test.ts', import.meta.url));
writeFileSync(outPath, out, 'utf8');
console.log(`wrote ${outPath} (${SAMPLES.length} sampled endpoints)`);
