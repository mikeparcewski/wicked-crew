/**
 * Regenerate the committed endpoint manifest (TH-11).
 *
 *   npm run manifest:endpoints -w packages/crew
 *
 * Boots the real server assembly headless (fake adapter, every seam disabled — see
 * src/api/endpoint-manifest-live.ts), reads the `onRoute`-accumulated route table, and writes
 * `packages/crew/endpoint-manifest.json`. The file is COMMITTED: tests/endpoint-manifest.test.ts
 * fails on any drift between it and the live route table, so an endpoint change fails CI until
 * this script is re-run and the manifest diff is reviewed alongside the route change.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { collectLiveEndpointManifest } from '../src/api/endpoint-manifest-live.js';

const manifest = await collectLiveEndpointManifest();
const out = fileURLToPath(new URL('../endpoint-manifest.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${out}: ${manifest.endpoints.length} endpoints (wicked-crew-api-types ${manifest.apiTypesVersion})`,
);
