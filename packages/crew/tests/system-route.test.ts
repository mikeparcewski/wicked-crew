// GET /api/v1/system over the REAL server assembly (createServer) on a scratch state home
// (DES-SYSTEM-VIEW). The container gateway is probed through a fake container runtime — a shell
// script `WICKED_CONTAINER_RUNTIME` names — that answers running, refuses connections, or hangs, so
// the route's real exec path, its per-probe timeout and its overall bound are what is tested.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsResponse, HealthResponse, SystemSnapshot } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { PROBE_TIMEOUT_MS, SYSTEM_BUDGET_MS } from '../src/api/system-snapshot.js';
import { removeScratch } from './setup/scratch.js';

// The disk reading is the real host's by default, so a host under 5% free turns `infra:disk` red and
// outranks the gateway these tests assert on (crew#1199). Report ample free space; the rest of the
// module stays real.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  statfs: async () => ({ bavail: 500_000, bsize: 1_000_000, blocks: 1_000_000 }),
}));

const ENV_KEYS = ['WICKED_SEAT_FLOOR', 'WICKED_CONTAINER_RUNTIME', 'WICKED_MEMORY_DB', 'WICKED_ESTATE_EXE', 'WICKED_ESTATE_MCP_EXE', 'LOG_LEVEL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let scratch: string;
let modeFile: string;
let app: FastifyInstance;

const posix = process.platform !== 'win32';

/** The engine fields every served run carries (the shape `gate-history.test.ts` fixtures use). */
const SESSION = {
  workflow_id: 'wf', entity_mode: 'none', collection_scope: null, clis: ['claude', 'codex'], human_confirm: 'all',
  unit_ix: 0, attempt: 0, workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  scratch = mkdtempSync(join(tmpdir(), 'crew-system-route-'));
  const home = join(scratch, 'state-home');
  mkdirSync(home);
  const dbPath = join(home, 'core.db');
  writeFileSync(dbPath, 'not-a-real-sqlite-file', 'utf8');
  const eventsDir = join(home, 'core.db.events');
  mkdirSync(eventsDir);
  writeFileSync(
    join(eventsDir, 'run-1.ndjson'),
    [
      JSON.stringify({ type: 'acpSessionStarted', session: 'run-1', cliKey: 'claude', acpSessionId: 'a', ts: 100, seq: 1 }),
      JSON.stringify({ type: 'acpFallback', session: 'run-1', cliKey: 'claude', fallbackKind: 'session_died', ts: 150, seq: 2 }),
    ].join('\n'),
    'utf8',
  );

  // The fake container runtime: `container inspect …` answers per the mode file.
  modeFile = join(scratch, 'mode');
  writeFileSync(modeFile, 'running', 'utf8');
  const runtime = join(scratch, 'fake-docker');
  writeFileSync(
    runtime,
    [
      '#!/bin/sh',
      `read mode < '${modeFile}'`,
      'case "$mode" in',
      '  running) echo true ;;',
      '  refuse) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;',
      '  hang) exec sleep 30 ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(runtime, 0o755);

  process.env['WICKED_SEAT_FLOOR'] = 'container';
  process.env['WICKED_CONTAINER_RUNTIME'] = runtime;
  // Estate is probed against a store that does not exist yet: no binary is spawned on the operator's.
  process.env['WICKED_MEMORY_DB'] = join(scratch, 'memory.db');
  process.env['WICKED_ESTATE_EXE'] = join(scratch, 'no-such-estate');
  // The estate MCP binary resolves (any executable; it is never spawned while the store is missing), so
  // the row reads "store not created yet" whether or not this host has wicked-estate installed (crew#1213).
  process.env['WICKED_ESTATE_MCP_EXE'] = process.execPath;
  process.env['LOG_LEVEL'] = 'error';

  const views = [
    {
      session: { ...SESSION, id: 'run-live', problem: 'fix the thing', status: 'executing', created_at: Math.floor(Date.now() / 1000) - 3600 },
      units: [{ id: 'run-live:0', ord: 0, status: 'distributed', phase_ref: 'fix', stage: 'build', assigned_cli: 'claude' }],
    },
    {
      session: { ...SESSION, id: 'run-gate', problem: 'plan it', status: 'awaiting_human', created_at: Math.floor(Date.now() / 1000) - 600 },
      units: [{ id: 'run-gate:1', ord: 1, status: 'pending', phase_ref: 'plan', stage: 'build', assigned_cli: 'claude' }],
    },
  ];
  // run-live's durable log was written just now: evidence of work.
  writeFileSync(join(eventsDir, 'run-live.ndjson'), JSON.stringify({ type: 'unitDispatched', session: 'run-live', ord: 0, ts: Date.now(), seq: 1 }), 'utf8');

  const adapter = {
    stub: true,
    dbPath,
    projectsSupported: () => false,
    getSettings: async () => ({ workerStallMinutes: 15 }),
    ping: async () => 'ok',
    listRepos: async () => [],
    sessionsDetail: async () => views,
    runEvents: async () => [],
    interactionRequests: async () => [
      { id: 'ir_gate1', session_id: 'run-gate', kind: 'gate', ord: 1, reviewing_ord: null, prompt: 'Approve the plan?', gate_kind: 'plan_approval', status: 'open', created_at: new Date().toISOString() },
    ],
    listConformanceRules: async () => [{ id: 'r1' }, { id: 'r2', retired: true }],
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
  } as unknown as CoreAdapter;

  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  removeScratch(scratch);
});

/** The gateway row until it reads `want`: a loaded host can push one `sh` spawn past the probe's
 *  bound, which honestly reads `unknown` — never the wrong verdict. Up to five reads. */
async function gatewayUntil(want: string): Promise<SystemSnapshot> {
  let last: SystemSnapshot | undefined;
  for (let i = 0; i < 5; i += 1) {
    last = (await snapshot()).body;
    const row = last.infra.find((r) => r.key === 'gateway')!;
    const state = row.state;
    if (state === want) return last;
    expect(state).toBe('unknown');
  }
  return last!;
}

async function snapshot(): Promise<{ body: SystemSnapshot; ms: number }> {
  const t0 = Date.now();
  const res = await app.inject({ method: 'GET', url: '/api/v1/system' });
  expect(res.statusCode).toBe(200);
  return { body: res.json() as SystemSnapshot, ms: Date.now() - t0 };
}

describe('GET /api/v1/system', () => {
  it('is advertised on /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect((res.json() as HealthResponse).capabilities?.system).toBe(true);
  });

  it('answers all five arrays; runs carry computed liveness', async () => {
    const { body } = await snapshot();
    expect(typeof body.checkedAt).toBe('string');
    expect(body.budgetMs).toBe(SYSTEM_BUDGET_MS);
    expect(Array.isArray(body.attention) && Array.isArray(body.clis) && Array.isArray(body.runs)).toBe(true);
    expect(body.infra.map((r) => r.key)).toEqual([
      'daemon', 'gateway', 'broker', 'interactive', 'estate', 'bus', 'vault', 'skills', 'state_home', 'stores', 'seat_floor', 'repos', 'disk', 'load',
    ]);
    const byId = Object.fromEntries(body.runs.map((r) => [r.runId, r]));
    expect(byId['run-gate']).toMatchObject({ liveness: 'waiting_on_you', gate: { interactionId: 'ir_gate1', ord: 1, kind: 'plan_approval' } });
    expect(byId['run-live']).toMatchObject({ liveness: 'working', evidence: 'event_log', phase: 'fix' });
    expect(body.runs[0]!.runId).toBe('run-gate'); // worst first
    const rules = body.governance.find((c) => c.key === 'steering_rules');
    expect(rules).toMatchObject({ state: 'ok', value: 1 });
    // The estate store does not exist yet: degraded, never a spawned probe of another store.
    expect(body.infra.find((r) => r.key === 'estate')!.state).toBe('degraded');
  });

  it.runIf(posix)('gateway: running → ok; refusing connections → down, tops attention, red; started again → ok', async () => {
    writeFileSync(modeFile, 'running', 'utf8');
    const up = await gatewayUntil('ok');
    expect(up.infra.find((r) => r.key === 'gateway')).toMatchObject({ state: 'ok' });
    expect(up.attention.find((a) => a.id === 'infra:gateway')).toBeUndefined();

    writeFileSync(modeFile, 'refuse', 'utf8');
    const down = await gatewayUntil('down');
    const gw = down.infra.find((r) => r.key === 'gateway')!;
    expect(gw.state).toBe('down');
    expect(gw.remedy).toMatch(/Start Docker/);
    expect(down.attention[0]).toMatchObject({ id: 'infra:gateway', severity: 'red', action: { kind: 'recheck' } });
    expect(down.level).toBe('red');

    writeFileSync(modeFile, 'running', 'utf8');
    const again = await gatewayUntil('ok');
    expect(again.infra.find((r) => r.key === 'gateway')!.state).toBe('ok');
  }, 120_000);

  it.runIf(posix)('gateway that hangs → unknown after its timeout, and the endpoint still answers within its bound', async () => {
    writeFileSync(modeFile, 'hang', 'utf8');
    const { body, ms } = await snapshot();
    const gw = body.infra.find((r) => r.key === 'gateway')!;
    expect(gw.state).toBe('unknown');
    expect(gw.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(gw.reason).toMatch(/did not answer within/);
    expect(ms).toBeLessThan(SYSTEM_BUDGET_MS);
    expect(body.attention.find((a) => a.id === 'infra:gateway')!.severity).toBe('yellow');
    writeFileSync(modeFile, 'running', 'utf8');
  }, 20_000);

  it('every /diagnostics block is reachable from the snapshot', async () => {
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    const { body } = await snapshot();
    const row = (k: string) => body.infra.find((r) => r.key === k)!.details;
    const card = (k: string) => body.governance.find((c) => c.key === k)!.details!;
    expect(row('daemon')['components']).toEqual(diag.components);
    expect((row('daemon')['daemon'] as { port: number }).port).toBe(diag.daemon.port);
    expect(row('daemon')['recentErrors']).toBeDefined();
    expect(row('stores')['stores']).toEqual(diag.stores);
    expect(row('skills')['skills']).toEqual(diag.skills);
    expect(row('state_home')['stateHome']).toBeDefined();
    expect(row('estate')['memoryStore']).toEqual(diag.memoryStore);
    expect(row('vault')['vault']).toEqual(diag.vault ?? null);
    expect(row('seat_floor')['hostBoundary']).toEqual(diag.seatGovernance?.hostBoundary ?? null);
    expect(row('seat_floor')['rosterFile']).toEqual(diag.seatGovernance?.rosterFile ?? null);
    expect(row('seat_floor')['roleFindings']).toEqual(diag.seatGovernance?.roleFindings ?? []);
    expect(card('dead_letters')['deadletters']).toEqual(diag.governance.deadletters);
    expect(card('findings')['governance']).toEqual(diag.governance.findings);
    expect(card('findings')['decisions']).toEqual(diag.decisions ?? null);
    expect(card('store')['store']).toEqual(diag.governance.store);
    for (const seat of diag.seatGovernance?.seats ?? []) {
      expect(body.clis.find((c) => c.cli === seat.cli)?.details.seatGovernance).toEqual(seat);
    }
    for (const [cli, fold] of Object.entries(diag.acp.byCli)) {
      const entry = body.clis.find((c) => c.cli === cli);
      if (entry !== undefined) expect(entry.details.acp).toEqual(fold);
    }
    // The Health page's Connection card: status, version and ping ride the daemon row.
    expect(row('daemon')['version']).toBe(diag.components.crew);
    expect(typeof row('daemon')['ping']).toBe('string');
  });
});
