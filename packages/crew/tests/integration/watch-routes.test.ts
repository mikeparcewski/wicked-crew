// DES-TRIGGER-REGISTRY-001 TR-W5a — the watch registry through the daemon, on the REAL engine bus.
//
// The adapter is a stub engine handed a bus (`busDbPath`), so the rows below go through the
// engine's own `Core.busEmit` / `Core.busRead` — the catalog and wire checks a live daemon applies.
//
//   - health answers and the registry arms on the engine bus; the two internal entries and the three
//     TR-W5b entries load;
//   - test 8: a `watch.*` settings patch from a worker bearer is 403 (even at admin trust), from a
//     person it lands, writes `settings.updated`, and shows in `health.entries.off` with who/when;
//   - a bad `watch` patch is a 400 naming the key; a person-only dismiss refuses a worker;
//   - `/ws` carries a `watchEvent` frame for a watch row on the bus (the relay, never a broadcast).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { WatchEntry, WatchHealth } from 'wicked-crew-api-types';
import { CoreAdapter } from '../../src/core/adapter.js';
import { emitOnBus } from '../../src/core/bus.js';
import { createServer } from '../../src/api/server.js';
import { tokenHash } from '../../src/api/auth.js';
import type { CrewSystemSettings } from '../../src/core/types.js';
import { WATCH_FINDING_RAISED } from '../../src/watch/events.js';
import { watchIdOf } from '../../src/watch/keys.js';
import { removeScratch } from '../setup/scratch.js';

const TOKENS = { person: 'person-admin-1', worker: 'worker-admin-1', operator: 'person-op-1' } as const;

let dir: string;
let busPath: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let base: string;
let settings: CrewSystemSettings;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'watch-routes-'));
  busPath = join(dir, 'bus', 'bus.db');
  mkdirSync(join(dir, 'bus'), { recursive: true }); // as the daemon's boot probe makes the bus dir
  writeFileSync(
    join(dir, 'tokens.json'),
    JSON.stringify({
      version: 1,
      tokens: [
        { sha256: tokenHash(TOKENS.person), actor: { id: 'root-op', kind: 'human', trust: 'admin' } },
        // A worker's MCP bearer: admin trust on paper, but not a person.
        { sha256: tokenHash(TOKENS.worker), actor: { id: 'worker-seat', kind: 'agent', trust: 'admin' } },
        { sha256: tokenHash(TOKENS.operator), actor: { id: 'maria', kind: 'human', trust: 'operator' } },
      ],
    }),
  );
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true, busDbPath: busPath });
  settings = { graphNodeLimit: 150 } as CrewSystemSettings;
  adapter.getSettings = async () => settings;
  adapter.updateSettings = async (patch: Partial<CrewSystemSettings>) => {
    settings = { ...settings, ...patch } as CrewSystemSettings;
    return settings;
  };
  adapter.sessionsDetail = async () => [];
  app = await createServer(adapter, {
    auth: { mode: 'required', tokensPath: join(dir, 'tokens.json') },
    auditPath: join(dir, 'audit.log'),
    projectEvents: { disabled: true },
    watch: { pollIntervalMs: 50, flushMs: 50, tickMs: 0 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // The registry arms in the background; wait for it.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = (await (await call('GET', '/api/v1/watch/health', TOKENS.operator)).json()) as WatchHealth;
    if (h.armed || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

function call(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('the watch registry on the daemon', () => {
  it('arms on the engine bus and lists the shipped entries (two internal, three TR-W5b, two TR-W6, one TR-W7, two WT-W4)', async () => {
    const h = (await (await call('GET', '/api/v1/watch/health', TOKENS.operator)).json()) as WatchHealth;
    expect(h.armed).toBe(true);
    expect(h.reason).toBeNull();
    expect(h.entries).toMatchObject({ loaded: 10, refused: [], off: [] });
    // TR-W7: scope-drift listens on the bus, so the pull is armed on the engine's bus.
    expect(h.sources.bus).toBe('ok');
    expect(h.llm.enabled).toBe(false);
    const { entries } = (await (await call('GET', '/api/v1/watch/entries', TOKENS.operator)).json()) as { entries: WatchEntry[] };
    expect(entries.map((e) => [e.id, e.enabled])).toEqual([
      ['added-by-hand', true],
      ['claim-vs-evidence', true],
      ['deliver-audit', true],
      ['quiet-after-claim', true],
      ['registry-check-failed', true],
      ['registry-lagging', true],
      ['risky-call', true],
      ['scope-drift', true],
      ['ungated', true],
      ['what-catches', true],
    ]);
    expect(entries.every((e) => e.threshold_text.length > 0)).toBe(true);
  });

  it('test 8: a worker bearer cannot change watch.* settings; a person can, and it is audited and shown', async () => {
    const patch = { watch: { entries: { 'registry-lagging': { enabled: false } } } };
    const refused = await call('PUT', '/api/v1/settings', TOKENS.worker, patch);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Only a person/);
    expect(settings.watch).toBeUndefined();

    const ok = await call('PUT', '/api/v1/settings', TOKENS.person, patch);
    expect(ok.status).toBe(200);
    expect(settings.watch?.entries?.['registry-lagging']).toMatchObject({ enabled: false, enabled_changed: { by: 'root-op' } });
    const h = (await (await call('GET', '/api/v1/watch/health', TOKENS.operator)).json()) as WatchHealth;
    expect(h.entries.off).toEqual([{ id: 'registry-lagging', by: 'root-op', at: expect.any(Number) }]);
    // The audit trail names the watch change.
    await new Promise((r) => setTimeout(r, 100));
    const trail = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const updated = trail.filter((e) => e['action'] === 'settings.updated');
    expect(updated.at(-1)).toMatchObject({ detail: { changed: ['watch'], watch: patch.watch } });

    // A caller cannot forge the stamp, and a bad patch names the key.
    const forged = await call('PUT', '/api/v1/settings', TOKENS.person, {
      watch: { entries: { 'registry-lagging': { enabled: true, enabled_changed: { by: 'someone-else', at: 1 } } } },
    });
    expect(forged.status).toBe(400);
    const badThreshold = await call('PUT', '/api/v1/settings', TOKENS.person, {
      watch: { entries: { 'registry-lagging': { threshold: { queue_depth: 'lots' } } } },
    });
    expect(badThreshold.status).toBe(400);
    expect(((await badThreshold.json()) as { error: string }).error).toMatch(/watch\.entries\.registry-lagging\.threshold/);
    // Back on, for the rest of the file.
    expect((await call('PUT', '/api/v1/settings', TOKENS.person, { watch: { entries: { 'registry-lagging': { enabled: true } } } })).status).toBe(200);
  });

  it('dismiss is a person-only command; an unknown row is a 404', async () => {
    const id = `w-${'a'.repeat(32)}`;
    expect((await call('POST', `/api/v1/watch/${id}/dismiss`, TOKENS.worker)).status).toBe(403);
    expect((await call('POST', `/api/v1/watch/${id}/dismiss`, TOKENS.operator)).status).toBe(404);
    expect((await call('POST', '/api/v1/watch/not-an-id/dismiss', TOKENS.operator)).status).toBe(400);
  });

  it('GET /watch validates its query', async () => {
    expect((await call('GET', '/api/v1/watch?kind=needs', TOKENS.operator)).status).toBe(400);
    expect((await call('GET', '/api/v1/watch?limit=0', TOKENS.operator)).status).toBe(400);
    const ok = (await (await call('GET', '/api/v1/watch?run=r-1', TOKENS.operator)).json()) as Record<string, unknown>;
    // A run the registry has seen nothing of: each run-scoped entry says it has not checked yet.
    expect(ok).toEqual({
      findings: [],
      cleared: [],
      coverage: [
        { entry_id: 'added-by-hand', state: 'not_checked', reason: 'the run has not ended yet' },
        { entry_id: 'claim-vs-evidence', state: 'not_checked', reason: 'no step has run its checks yet' },
        { entry_id: 'deliver-audit', state: 'not_checked', reason: 'nothing was delivered on this run yet' },
        { entry_id: 'quiet-after-claim', state: 'not_checked', reason: 'no step has handed back yet' },
        { entry_id: 'risky-call', state: 'not_checked', reason: 'no governed tool call has reached a gate yet' },
        { entry_id: 'scope-drift', state: 'not_checked', reason: 'no creator floor has run yet' },
        { entry_id: 'ungated', state: 'not_checked', reason: 'no step has reached its gate yet' },
        { entry_id: 'what-catches', state: 'not_checked', reason: 'the run has not ended yet' },
      ],
    });
  });

  it('/ws carries a watchEvent frame for a watch row the engine took on its bus', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Authorization: `Bearer ${TOKENS.operator}` } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as Record<string, unknown>;
      if (f['type'] === 'watchEvent') frames.push(f);
    });
    const watchId = watchIdOf(null, 'registry-lagging', 1, 'lag:42');
    // The engine itself accepts the row (domain, type and wire fields as the emitter writes them).
    await emitOnBus(busPath, {
      event_type: WATCH_FINDING_RAISED,
      domain: 'wicked-crew',
      subdomain: 'watch',
      producer_id: 'wicked-crew',
      idempotency_key: watchId.slice(2),
      payload: { run_id: null, watch_id: watchId, entry_id: 'registry-lagging', sentence: 'Watching is falling behind.' },
    });
    const deadline = Date.now() + 10_000;
    while (frames.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(frames[0]).toMatchObject({ type: 'watchEvent', event: { event_type: WATCH_FINDING_RAISED, payload: { watch_id: watchId } } });
  });
});
