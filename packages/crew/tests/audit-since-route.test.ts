// GET /api/v1/audit?since= — the inclusive lower time bound a skin's "while you were away"
// handover reads (studio wave 2b). Over the REAL server assembly on a scratch trail: the same
// headless-boot recipe as diagnostics-route (stub adapter, every seam disabled, audit to a temp
// file), with the trail file seeded directly so every entry carries a known `ts`.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditEntry, AuditPage } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { AuditLog } from '../src/api/audit.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

const SYSTEM = { id: 'crew.watchdog', kind: 'system', trust: 'admin' } as const;
const HUMAN = { id: 'local', kind: 'human', trust: 'admin' } as const;

const TRAIL: AuditEntry[] = [
  { ts: 1_000, action: 'run.launched', actor: HUMAN, runId: 'r1' },
  { ts: 2_000, action: 'run.stall.escalated', actor: SYSTEM, runId: 'r1' },
  { ts: 3_000, action: 'gate.decided', actor: HUMAN, runId: 'r2' },
  { ts: 4_000, action: 'run.stall.escalated', actor: SYSTEM, runId: 'r2' },
];

let scratch: string;
let auditPath: string;
let app: FastifyInstance;
let savedLogLevel: string | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-audit-since-'));
  auditPath = join(scratch, 'audit.log');
  writeFileSync(auditPath, TRAIL.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'error';
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath,
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

const get = async (qs: string): Promise<{ status: number; body: AuditPage & { error?: string } }> => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/audit${qs}` });
  return { status: res.statusCode, body: res.json() as AuditPage & { error?: string } };
};

describe('GET /api/v1/audit?since= (inclusive lower bound, unix millis)', () => {
  it('keeps only entries at or after `since`, newest first', async () => {
    const { status, body } = await get('?since=2000');
    expect(status).toBe(200);
    expect(body.entries.map((e) => e.ts)).toEqual([4_000, 3_000, 2_000]);
  });

  it('composes with ?action= and ?runId=', async () => {
    const byAction = await get('?since=2500&action=run.stall.escalated');
    expect(byAction.body.entries.map((e) => [e.ts, e.runId])).toEqual([[4_000, 'r2']]);
    const byRun = await get('?since=1500&runId=r1');
    expect(byRun.body.entries.map((e) => e.action)).toEqual(['run.stall.escalated']);
  });

  it('a `since` past the newest entry answers an empty page, never an error', async () => {
    const { status, body } = await get('?since=9999');
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
  });

  it('absent `since` is the unfiltered trail (the existing contract)', async () => {
    const { body } = await get('');
    expect(body.entries).toHaveLength(TRAIL.length);
  });

  it.each(['abc', '-1', '1.5', '10abc'])('refuses since=%j with a 400', async (raw) => {
    const { status, body } = await get(`?since=${encodeURIComponent(raw)}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/since/);
  });

  it('an empty `since` is absent (the trim rule every audit param follows)', async () => {
    const { status, body } = await get('?since=');
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(TRAIL.length);
  });
});

describe('AuditLog.read({ since })', () => {
  it('filters on the entry clock before the limit trims', async () => {
    const log = new AuditLog(auditPath);
    expect((await log.read({ since: 3_000 })).map((e) => e.ts)).toEqual([4_000, 3_000]);
    // The limit applies AFTER the bound: the newest N of the in-window entries.
    expect((await log.read({ since: 1_000, limit: 1 })).map((e) => e.ts)).toEqual([4_000]);
  });
});
