/**
 * Build the LIVE endpoint manifest by booting the real server assembly (TH-11).
 *
 * A separate module from endpoint-manifest.ts on purpose: this imports `createServer` while
 * server.ts imports the hook installer — folding both into one file would make the cycle
 * structural instead of avoiding it.
 *
 * # Why boot `createServer` rather than re-list routes by hand
 *
 * The manifest's whole value is that it cannot drift from the daemon: it is read from the same
 * `onRoute` hook, over the same registration calls (`registerRoutes`, project routes, terminal
 * WS, `/ws`, interactive event routes), that the served daemon runs. A hand-maintained list would
 * be a second spelling of the route table — the exact thing the manifest exists to end.
 *
 * # What is faked, and why it is safe
 *
 * Route REGISTRATION never calls the engine — only handlers do, and no request is ever injected
 * here. The adapter stub answers the three things `createServer` itself asks at boot:
 * `getSettings()` (worker-config root export), `projectsSupported()` → false (skips membership
 * hydration), and `stub: true` (any answering seam that were ever armed would refuse rather than
 * subscribe). Every optional seam is disabled explicitly, the audit trail goes to a temp file
 * (never `~/.wicked-crew/audit.log`), and `studioRoot` points at a nonexistent directory so the
 * server boots HEADLESS — deliberately: the static wildcard route depends on whether a studio
 * bundle is installed on the generating machine, and a committed manifest must not vary by
 * install state. The manifest documents the API + WS surface.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoreAdapter } from '../core/adapter.js';
import { createServer } from './server.js';
import { buildEndpointManifest, type EndpointManifest } from './endpoint-manifest.js';

export async function collectLiveEndpointManifest(): Promise<EndpointManifest> {
  // Deterministic boot: auth mode is pinned OFF via options (no env/file resolution), and the
  // logger is silenced for the duration — this runs inside test output and CI logs.
  const savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'silent';
  const scratch = mkdtempSync(join(tmpdir(), 'crew-endpoint-manifest-'));
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    // The daemon's single CoreEvent fan-out subscribes at boot; no event ever arrives here.
    onEvent: () => () => {},
  } as unknown as CoreAdapter;
  try {
    const app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      seatHealthProbe: { enabled: false },
      stallWatchdog: { enabled: false },
      // Nonexistent on purpose — headless boot; see the module header.
      studioRoot: join(scratch, 'no-studio-bundle'),
    });
    try {
      await app.ready();
      return buildEndpointManifest(app.endpointManifest ?? []);
    } finally {
      await app.close();
    }
  } finally {
    if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = savedLogLevel;
    rmSync(scratch, { recursive: true, force: true });
  }
}
