// POST /api/v1/governance/deadletters/replay — the `governance replay` CLI (crew#495) as a route,
// over the daemon's OWN outbox and store, so a skin can offer the repair beside the dead-letter
// count it already shows. Over the REAL server assembly (createServer) with a stub adapter that
// carries a scratch governance store location. The dry run is pinned on every engine; the real
// replay is pinned through a spy on the engine static (the CLI test pins the real binding).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { GovernanceStoreLocation } from '../src/core/governance-store.js';
import { removeScratch } from './setup/scratch.js';

const REC = (type: string, reason: string, ts: number): string =>
  JSON.stringify({ type, domain: 'wicked-governance', subdomain: 'governance.rules', payload: {}, deadletter_reason: reason, ts });

let scratch: string;
let sidecar: string;
let location: GovernanceStoreLocation;
let app: FastifyInstance;
let savedLogLevel: string | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-governance-replay-route-'));
  const coreDbPath = join(scratch, 'core.db');
  sidecar = `${coreDbPath}.governance`;
  mkdirSync(sidecar, { recursive: true });
  location = {
    dbPath: join(sidecar, 'governance.db'),
    displayPath: join(sidecar, 'governance.db'),
    source: 'core-db-sidecar',
    outboxPath: join(sidecar, 'emit-outbox.ndjson'),
    outboxSource: 'core-db-sidecar',
    sidecarDir: sidecar,
    coreDbPath,
  };
  savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'error';
  const adapter = {
    stub: true,
    governanceStore: location,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

const post = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/governance/deadletters/replay', payload: body as object });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
};

const seed = (lines: string[]): void => {
  writeFileSync(location.outboxPath, `${lines.join('\n')}\n`, 'utf8');
};

describe('POST /api/v1/governance/deadletters/replay', () => {
  it('rejects an unknown body key (strict body)', async () => {
    const r = await post({ dryRun: true, outbox: '/etc/passwd' });
    expect(r.status).toBe(400);
  });

  it('with no outbox on disk answers a zero outcome, never an error', async () => {
    const r = await post({ dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body['read']).toBe(0);
    expect(r.body['dryRun']).toBe(true);
  });

  it('dry run folds the outbox, moves nothing, and says whether a real replay could run', async () => {
    seed([
      REC('wicked.crew.governance.conformance_recorded', 'no shared store (WICKED_ESTATE_DB unset)', 1_000),
      REC('wicked.crew.governance.conformance_recorded', 'no shared store (WICKED_ESTATE_DB unset)', 2_000),
      REC('wicked.estate.rule.retired', 'store write failed: locked', 3_000),
    ]);
    const before = readFileSync(location.outboxPath, 'utf8');
    const r = await post({ dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body['dryRun']).toBe(true);
    expect(r.body['read']).toBe(3);
    expect(r.body['replayed']).toBe(0);
    expect(r.body['archive']).toBeNull();
    const fold = r.body['fold'] as { byType: Record<string, number>; byReason: Record<string, number> };
    expect(fold.byType['wicked.crew.governance.conformance_recorded']).toBe(2);
    expect(Object.values(fold.byReason).reduce((a, b) => a + b, 0)).toBe(3);
    // `blocker` is null exactly when this engine can replay.
    expect(r.body['blocker'] === null).toBe(CoreAdapter.replayEmitOutboxSupported());
    // Nothing moved.
    expect(readFileSync(location.outboxPath, 'utf8')).toBe(before);
    expect(readdirSync(sidecar).filter((f) => f.includes('.replayed-'))).toEqual([]);
  });

  it('a real replay drains the outbox; what fails goes back onto it and stays a dead letter', async () => {
    const failedLine = REC('wicked.estate.rule.retired', 'store write failed: locked', 3_000);
    seed([
      REC('wicked.crew.governance.conformance_recorded', 'no shared store (WICKED_ESTATE_DB unset)', 1_000),
      failedLine,
    ]);
    vi.spyOn(CoreAdapter, 'replayEmitOutboxSupported').mockReturnValue(true);
    vi.spyOn(CoreAdapter, 'replayEmitOutbox').mockResolvedValue({
      read: 2,
      replayed: 1,
      already_present: 0,
      failed: [{ line: failedLine, reason: 'locked' }],
    } as unknown as Awaited<ReturnType<typeof CoreAdapter.replayEmitOutbox>>);
    const r = await post({ dryRun: false });
    expect(r.status).toBe(200);
    expect(r.body['dryRun']).toBe(false);
    expect(r.body['read']).toBe(2);
    expect(r.body['replayed']).toBe(1);
    expect(r.body['failed']).toBe(1);
    expect(typeof r.body['archive']).toBe('string');
    expect(existsSync(r.body['archive'] as string)).toBe(true);
    // Only the failed entry remains on the live outbox.
    const live = readFileSync(location.outboxPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(live).toEqual([failedLine]);
    // The mutation is audited.
    const audit = await app.inject({ method: 'GET', url: '/api/v1/audit' });
    expect(audit.body).toContain('governance.deadletters.replayed');
  });

  it('while a real replay runs, both modes answer 409 — never a false zero off the renamed outbox', async () => {
    seed([REC('wicked.crew.governance.conformance_recorded', 'no shared store (x)', 1_000)]);
    vi.spyOn(CoreAdapter, 'replayEmitOutboxSupported').mockReturnValue(true);
    let release: () => void = () => {};
    vi.spyOn(CoreAdapter, 'replayEmitOutbox').mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ read: 1, replayed: 1, already_present: 0, failed: [] } as unknown as Awaited<ReturnType<typeof CoreAdapter.replayEmitOutbox>>);
      }),
    );
    const first = app.inject({ method: 'POST', url: '/api/v1/governance/deadletters/replay', payload: {} });
    // Let the first request reach the engine call (the outbox is renamed by then).
    await vi.waitFor(() => expect(existsSync(location.outboxPath)).toBe(false));
    expect((await post({})).status).toBe(409);
    expect((await post({ dryRun: true })).status).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('a real replay on an engine without the binding is refused (501) with the outbox untouched', async () => {
    seed([REC('wicked.crew.governance.conformance_recorded', 'no shared store (x)', 1_000)]);
    const before = readFileSync(location.outboxPath, 'utf8');
    vi.spyOn(CoreAdapter, 'replayEmitOutboxSupported').mockReturnValue(false);
    const r = await post({});
    expect(r.status).toBe(501);
    expect(readFileSync(location.outboxPath, 'utf8')).toBe(before);
  });
});
