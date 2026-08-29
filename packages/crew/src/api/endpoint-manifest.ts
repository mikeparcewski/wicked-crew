/**
 * The endpoint manifest (TH-11) — crew's route table as a MACHINE-READABLE build artifact.
 *
 * # Why this exists
 *
 * routes.ts declares zero fastify schemas (verified: grep `schema:` = 0), no OpenAPI spec exists
 * anywhere in crew, and `wicked-crew-api-types` is types-only with no endpoint-to-type binding —
 * so nothing machine-readable said which methods+paths this daemon serves, what a request body is
 * called, or which status codes a route can answer. Request validation is NOT a vacuum (13
 * `.strict()` zod objects guard the bodies), but zod objects are route-internal: a test harness,
 * a drift check, or an API-test generator had nothing to read. With no fastify schemas declared,
 * `@fastify/swagger` has nothing to generate from either — the `onRoute` hook IS the cheap path.
 *
 * # How it works
 *
 * {@link installEndpointManifestHook} registers a fastify `onRoute` hook (added by `createServer`
 * BEFORE any route registration, so every route the daemon serves is seen) that accumulates one
 * {@link EndpointEntry} per method+path. Two declaration channels feed the type/status fields:
 *
 *   1. `config.manifest` on the route options ({@link ManifestRouteConfig}) — the explicit
 *      channel. Names should reference `wicked-crew-api-types` exports where one exists
 *      (`LaunchRunBody`, `GateDecision`, …) so the manifest binds endpoints to the published
 *      wire contract; a structural spelling (`'{ runId: string }'`) is the honest fallback for
 *      wire shapes the contract has no name for.
 *   2. `schema.response` keys, when fastify schemas start existing (the longer-term
 *      zod-to-json-schema path) — status codes are folded in automatically, so migrating a route
 *      to real fastify schemas enriches the manifest without touching this module.
 *
 * Routes that declare neither still land in the manifest with `requestType`/`responseType` null
 * and `statusCodes: []` — the manifest records "where declared", never invents.
 *
 * # What consumes it
 *
 * - `scripts/generate-endpoint-manifest.ts` (npm run manifest:endpoints) writes the committed
 *   `endpoint-manifest.json` at the package root — the build artifact.
 * - `tests/endpoint-manifest.test.ts` rebuilds the live route table and fails on ANY drift from
 *   the committed file, so an added/removed/renamed endpoint fails CI until the manifest is
 *   regenerated and the diff reviewed. The manifest diff IS the API regression trigger.
 * - `scripts/generate-api-tests.ts` derives positive + 400/404/409 negative API tests from the
 *   committed manifest (see `tests/generated/`).
 *
 * HEAD entries are dropped: fastify v5 auto-exposes a HEAD twin for every GET
 * (`exposeHeadRoutes`), which would double the GET surface with rows nobody declared.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';

/** The explicit per-route declaration channel — `{ config: { manifest: {...} } }` on a route. */
export interface ManifestRouteConfig {
  /** Request-body type name — a `wicked-crew-api-types` export where one exists. */
  requestType?: string;
  /** Success-response type name, or a structural spelling when the contract has no name for it. */
  responseType?: string;
  /** Every status code this route answers on purpose (success + named error codes). */
  statusCodes?: number[];
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** TH-11 — this route's row in the committed endpoint manifest. */
    manifest?: ManifestRouteConfig;
  }
  interface FastifyInstance {
    /** Accumulated by `createServer`'s onRoute hook; read after `app.ready()`. */
    endpointManifest?: EndpointEntry[];
  }
}

/** One method+path the daemon serves. */
export interface EndpointEntry {
  method: string;
  path: string;
  /** Declared request-body type name, or null — "where declared", never invented. */
  requestType: string | null;
  /** Declared response type name, or null. */
  responseType: string | null;
  /** Declared status codes (config.manifest + fastify schema.response keys), sorted. */
  statusCodes: number[];
  /** Present (true) only on websocket routes (`/ws`, `/ws/terminals/:id`). */
  websocket?: boolean;
}

/** The committed artifact's shape (endpoint-manifest.json). */
export interface EndpointManifest {
  version: 1;
  /**
   * The `wicked-crew-api-types` version this route table was generated against — the published
   * wire contract the type names bind to. Evidence manifests that cite endpoints should carry
   * this (recon R8/R11: api-types drift is live; studio pinned ^0.8.0 against 0.10.0).
   */
  apiTypesVersion: string;
  /** Sorted by path, then method — a stable order so drift diffs are readable. */
  endpoints: EndpointEntry[];
}

/**
 * Register the accumulating `onRoute` hook. MUST run before any route is registered — fastify
 * only replays `onRoute` for routes added after the hook exists. Returns the live array the hook
 * appends to; `createServer` exposes it as `app.endpointManifest`.
 */
export function installEndpointManifestHook(app: FastifyInstance): EndpointEntry[] {
  const entries: EndpointEntry[] = [];
  app.addHook('onRoute', (route: RouteOptions & { path?: string; prefix?: string }) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const declared = route.config?.manifest;
    // The future-proofing channel: fastify response schemas keyed by status code. None exist
    // today (routes.ts declares zero), but the fold means the zod→fastify-schema migration
    // enriches the manifest for free.
    const schemaResponse = (route.schema as { response?: Record<string, unknown> } | undefined)
      ?.response;
    const schemaCodes = Object.keys(schemaResponse ?? {})
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
    const statusCodes = [...new Set([...(declared?.statusCodes ?? []), ...schemaCodes])].sort(
      (a, b) => a - b,
    );
    const websocket = (route as { websocket?: boolean }).websocket === true;
    for (const method of methods) {
      // Fastify v5 auto-exposes a HEAD twin per GET; recording it would double the GET surface
      // with rows nobody declared and no client calls on purpose.
      if (method === 'HEAD') continue;
      entries.push({
        method,
        path: route.url,
        requestType: declared?.requestType ?? null,
        responseType: declared?.responseType ?? null,
        statusCodes,
        ...(websocket ? { websocket: true as const } : {}),
      });
    }
  });
  return entries;
}

/**
 * The published wire contract's version, read from the actually-installed dependency.
 *
 * NOT `require('wicked-crew-api-types/package.json')`: that package's exports map exposes only
 * `.` (types-only, no runtime condition), so both the subpath and a bare resolve are refused.
 * Walking the resolver's candidate directories and reading the file with fs sidesteps the
 * exports map while still honoring the real resolution order (workspace link included).
 */
export function apiTypesVersion(): string {
  const require = createRequire(import.meta.url);
  for (const dir of require.resolve.paths('wicked-crew-api-types') ?? []) {
    const pkgPath = join(dir, 'wicked-crew-api-types', 'package.json');
    if (existsSync(pkgPath)) {
      return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
    }
  }
  throw new Error(
    'wicked-crew-api-types is not resolvable from packages/crew — the manifest cannot stamp the wire-contract version',
  );
}

/** Entries → the committed artifact: stable order, contract version stamped. */
export function buildEndpointManifest(entries: EndpointEntry[]): EndpointManifest {
  const endpoints = [...entries].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  return { version: 1, apiTypesVersion: apiTypesVersion(), endpoints };
}
