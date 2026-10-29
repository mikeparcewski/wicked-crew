// GET /api/v1/diagnostics `floorCache` (crew#1147): `Core.floorCacheUsage` read once per 60 s,
// home paths shown as `~/...`, `null` on an addon without the static.

import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsResponse } from 'wicked-crew-api-types';

import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { FLOOR_CACHE_TTL_MS, FloorCacheCache } from '../src/api/diagnostics.js';
import { removeScratch } from './setup/scratch.js';

const home = '/home/someone';
const usage = {
  path: `${home}/.wicked/worker/repo-checks`,
  bytes: 1000,
  totalCapBytes: 5000,
  repoCapBytes: 2000,
  idleTtlSecs: 60,
  repos: [{ name: 'r', bytes: 1000, leaves: 2 }],
  logs: { path: `${home}/.wicked/worker/logs`, bytes: 10, capBytes: 100 },
};

describe('FloorCacheCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers null on an addon without the static', async () => {
    expect(await new FloorCacheCache(null, FLOOR_CACHE_TTL_MS, home).get()).toBeNull();
  });

  it('answers the engine object with ~/ paths and reads once within 60 s', async () => {
    const read = vi.fn(async () => JSON.stringify(usage));
    const cache = new FloorCacheCache(read, FLOOR_CACHE_TTL_MS, home);
    const first = await cache.get();
    expect(first).toMatchObject({ path: '~/.wicked/worker/repo-checks', bytes: 1000, logs: { path: '~/.wicked/worker/logs' } });
    vi.advanceTimersByTime(FLOOR_CACHE_TTL_MS - 1);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('answers { error } (tilded) when the read throws, and passes the engine { error } through', async () => {
    const bad = new FloorCacheCache(async () => { throw new Error(`boom ${home}`); }, FLOOR_CACHE_TTL_MS, home);
    expect(await bad.get()).toEqual({ error: 'boom ~' });
    const none = new FloorCacheCache(async () => JSON.stringify({ error: 'no worker home' }), FLOOR_CACHE_TTL_MS, home);
    expect(await none.get()).toEqual({ error: 'no worker home' });
  });
});

// `CoreAdapter.floorCacheReader` is what reads the addon's static (the napi class is read-only).
describe('GET /api/v1/diagnostics floorCache (route)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-floor-cache-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    removeScratch(scratch);
  });

  async function read(): Promise<DiagnosticsResponse> {
    const adapter = {
      stub: true,
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: () => () => {},
    } as unknown as CoreAdapter;
    const app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
    });
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
      const body = res.json() as DiagnosticsResponse;
      await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
      return body;
    } finally {
      await app.close();
    }
  }

  it('is null on an addon without the static', async () => {
    vi.spyOn(CoreAdapter, 'floorCacheReader').mockReturnValue(null);
    expect((await read()).floorCache).toBeNull();
  });

  it('carries the engine object (home shown as ~) and reads it once across polls', async () => {
    const fn = vi.fn(async () => JSON.stringify({ ...usage, path: `${homedir()}/w/repo-checks` }));
    vi.spyOn(CoreAdapter, 'floorCacheReader').mockReturnValue(fn);
    const body = await read();
    expect(body.floorCache).toMatchObject({ path: '~/w/repo-checks', bytes: 1000 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
