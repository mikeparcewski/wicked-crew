// GET /api/v1/system over the REAL server assembly (createServer) on a scratch state home
// (DES-SYSTEM-VIEW). The container gateway is probed through a fake container runtime — a shell
// script `WICKED_CONTAINER_RUNTIME` names — that answers running, refuses connections, or hangs, so
// the route's real exec path, its per-probe timeout and its overall bound are what is tested.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsResponse, HealthResponse, SystemSnapshot } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { DeskSnoozes } from '../src/api/desk-snoozes.js';
import { createServer } from '../src/api/server.js';
import { SYSTEM_BUDGET_MS } from '../src/api/system-snapshot.js';
import { removeScratch } from './setup/scratch.js';

// The disk reading is the real host's by default, so a host under 5% free turns `infra:disk` red and
// outranks the gateway these tests assert on (crew#1199). Report ample free space; the rest of the
// module stays real.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  statfs: async () => ({ bavail: 500_000, bsize: 1_000_000, blocks: 1_000_000 }),
}));
// RED (this commit only): the macOS CI runner's condition, a saturated host (the 1-minute load at 6 per core), which
// the load row reads from the real host and calls `down` (red) at 5 per core.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, loadavg: () => [os.cpus().length * 6, 0, 0] };
});

const ENV_KEYS = ['WICKED_SEAT_FLOOR', 'WICKED_CONTAINER_RUNTIME', 'WICKED_CORE_EXE', 'WICKED_MEMORY_DB', 'WICKED_ESTATE_EXE', 'WICKED_ESTATE_MCP_EXE', 'LOG_LEVEL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let scratch: string;
let modeFile: string;
let seatStatusFile: string;
let app: FastifyInstance;
/** The open gate's opening: Unix millis, as the engine's InteractionRequest row carries it (crew-api-types
 *  `InteractionRequest.created_at`; core stamps it at each opening). A test moves it to re-open the gate. */
let gateOpenedAt = Date.now() - 300_000;
/** The open gate's kind; `escalation` holds the run (red). */
let gateKind = 'plan_approval';

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

  // The fake engine: `seat-image status --json` prints the status file (the row's real exec path).
  seatStatusFile = join(scratch, 'seat-status.json');
  writeFileSync(seatStatusFile, JSON.stringify(seatStatus({})), 'utf8');
  const core = join(scratch, 'fake-wicked-core');
  writeFileSync(
    core,
    [
      '#!/bin/sh',
      `[ "$1 $2" = "seat-image status" ] && exec cat '${seatStatusFile}'`,
      // `cluster status --json` (k8s runner): the cluster and its gateway answer per the mode file.
      `if [ "$1 $2" = "cluster status" ]; then read mode < '${modeFile}'; case "$mode" in`,
      `  running) echo '${JSON.stringify({ configured: true, reachable: true, context: 'rancher-desktop', controller: { ready: true }, gateway: 'serving', controllerVersion: 'v0.1.0', runNamespaces: 0, pendingPods: 0 })}'; exit 0 ;;`,
      `  refuse) echo '${JSON.stringify({ configured: true, reachable: false, kind: 'cluster_unreachable', context: 'rancher-desktop' })}'; exit 1 ;;`,
      `  stopped) echo '${JSON.stringify({ configured: true, reachable: true, context: 'rancher-desktop', controller: { ready: true }, gateway: 'stopped', controllerVersion: 'v0.1.0', runNamespaces: 0, pendingPods: 0 })}'; exit 0 ;;`,
      '  hang) exec sleep 30 ;;',
      'esac; fi',
      'exit 2',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(core, 0o755);
  process.env['WICKED_CORE_EXE'] = core;

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
      { id: 'ir_gate1', session_id: 'run-gate', kind: 'gate', ord: 1, reviewing_ord: null, prompt: 'Approve the plan?', gate_kind: gateKind, status: 'open', created_at: gateOpenedAt },
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

/** A `wicked-core seat-image status --json` answer: every image present and held, the VM disk at
 *  40 %, unless `over` says otherwise. */
function seatStatus(over: { claudePresent?: boolean; usedPct?: number }): unknown {
  const seat = (cli: string, present = true) => ({ cli, image: `wicked-seat-${cli}:1`, present, held: present, operatorImage: false });
  return {
    runtime: 'docker',
    base: { image: 'wicked-seat-base:rust', present: true, held: true },
    baseRecipe: false,
    floor: { image: 'wicked-floor:1', present: true, held: true },
    seats: ['claude', 'codex', 'pi', 'copilot', 'agy', 'opencode'].map((c) => seat(c, c === 'claude' ? (over.claudePresent ?? true) : true)),
    disk: { totalBytes: 100 * 2 ** 30, availBytes: (100 - (over.usedPct ?? 40)) * 2 ** 30, usedPct: over.usedPct ?? 40 },
    imageGcHighPct: 85,
  };
}

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
      'daemon', 'gateway', 'broker', 'interactive', 'estate', 'bus', 'vault', 'skills', 'state_home', 'stores', 'seat_floor', 'cluster', 'seat_images', 'repos', 'delivery', 'disk', 'load',
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

  it.runIf(posix)('cluster + gateway (k8s runner): serving → ok; cluster not answering → cluster down, tops attention, red, gateway unobserved; quarantined gateway → down; back → ok', async () => {
    writeFileSync(modeFile, 'running', 'utf8');
    const up = await gatewayUntil('ok');
    expect(up.infra.find((r) => r.key === 'cluster')).toMatchObject({ state: 'ok' });
    expect(up.attention.find((a) => a.id === 'infra:gateway' || a.id === 'infra:cluster')).toBeUndefined();

    writeFileSync(modeFile, 'refuse', 'utf8');
    const down = (await snapshot()).body;
    const cluster = down.infra.find((r) => r.key === 'cluster')!;
    expect(cluster).toMatchObject({ state: 'down', reason: expect.stringContaining("Kubernetes isn't answering") });
    expect(cluster.remedy).toMatch(/Start Rancher Desktop/);
    expect(down.infra.find((r) => r.key === 'gateway')!.state).toBe('unknown');
    expect(down.attention[0]).toMatchObject({ id: 'infra:cluster', severity: 'red', action: { kind: 'recheck' } });
    // A dead cluster holds every live container run (run-live is working): the item counts it.
    expect((down.attention[0] as { blocks?: number }).blocks).toBeGreaterThanOrEqual(1);
    expect(down.level).toBe('red');

    writeFileSync(modeFile, 'stopped', 'utf8');
    const quarantined = await gatewayUntil('down');
    expect(quarantined.infra.find((r) => r.key === 'gateway')!.reason).toMatch(/quarantine/);

    writeFileSync(modeFile, 'running', 'utf8');
    const again = await gatewayUntil('ok');
    expect(again.infra.find((r) => r.key === 'gateway')!.state).toBe('ok');
  }, 120_000);

  it.runIf(posix)('gateway that hangs → unknown after its timeout, and the endpoint still answers within its bound', async () => {
    writeFileSync(modeFile, 'hang', 'utf8');
    const { body, ms } = await snapshot();
    const gw = body.infra.find((r) => r.key === 'gateway')!;
    expect(gw.state).toBe('unknown');
    // The wait this snapshot gave it is the settle timer's measured wait. Its clamp to the engine's bound is proven
    // with fake timers (cluster-status.test.ts); here a loaded runner fires the timer late (6179 ms against the
    // 6000 ms bound, crew#1780), so the route is held to the order of events: the wait ended inside the snapshot,
    // and the snapshot answered within its own budget, long before the 30 s hang would have.
    expect(gw.timeoutMs).toBeGreaterThan(0);
    expect(gw.timeoutMs).toBeLessThanOrEqual(ms);
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

describe('seat images on GET /system', () => {
  afterEach(() => {
    writeFileSync(seatStatusFile, JSON.stringify(seatStatus({})), 'utf8');
  });

  async function seatRow(): Promise<{ body: SystemSnapshot; row: SystemSnapshot['infra'][number] }> {
    // A loaded host can push the fake engine's spawn past the probe's bound (an honest `unknown`).
    let body: SystemSnapshot | undefined;
    for (let i = 0; i < 5; i += 1) {
      body = (await snapshot()).body;
      const row = body.infra.find((r) => r.key === 'seat_images')!;
      if (row.state !== 'unknown') return { body, row };
    }
    return { body: body!, row: body!.infra.find((r) => r.key === 'seat_images')! };
  }

  it.runIf(posix)('present and held, disk at 40 %: ok, nothing in attention', async () => {
    writeFileSync(seatStatusFile, JSON.stringify(seatStatus({})), 'utf8');
    const { body, row } = await seatRow();
    expect(row.state).toBe('ok');
    expect(row.reason).toMatch(/present and held; runtime VM disk 40% used/);
    expect(body.attention.find((a) => a.id === 'infra:seat_images')).toBeUndefined();
  }, 60_000);

  it.runIf(posix)('a roster seat image missing: a fixable item with "Rebuild seat images", even with no run held', async () => {
    writeFileSync(seatStatusFile, JSON.stringify(seatStatus({ claudePresent: false })), 'utf8');
    const { body, row } = await seatRow();
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/seat images missing: claude/);
    expect(body.attention.find((a) => a.id === 'infra:seat_images')).toMatchObject({
      severity: 'yellow',
      kind: 'slows',
      action: { kind: 'rebuild_seat_images', label: 'Rebuild seat images' },
    });
  }, 60_000);

  it.runIf(posix)('the VM disk past 75 %: a warning naming the 85 % image cleanup, before it runs', async () => {
    writeFileSync(seatStatusFile, JSON.stringify(seatStatus({ usedPct: 80 })), 'utf8');
    const { body, row } = await seatRow();
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/80% used.*from 85% a kubelet's image cleanup/);
    expect(row.remedy).toMatch(/docker volume prune/);
    // A rebuild does not free disk: the item re-checks.
    expect(body.attention.find((a) => a.id === 'infra:seat_images')!.action).toMatchObject({ kind: 'recheck' });
  }, 60_000);

});

// studio#1416 (crew#1124 on the ranked /needs page): a person snoozes an attention item. crew names the item's
// occurrence (`snooze.key`: the open interaction's id and that opening's time, so a gate asked again is a new key) and
// its rank; while the snooze holds (end ahead, rank no higher than the one stored) the item leaves attention[] and the
// level, and waits in `snoozed[]` with its end.
describe('GET /api/v1/system: snoozed items (studio#1416)', () => {
  type Snoozable = SystemSnapshot['attention'][number] & { snooze?: { key: string; rank: number } };
  type Held = Snoozable & { until: string };
  const gateItem = (b: SystemSnapshot): Snoozable | undefined => (b.attention as Snoozable[]).find((a) => a.id === 'run:run-gate');
  const put = (key: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/v1/desk/snoozes/${encodeURIComponent(key)}`, payload: body });
  const wake = (key: string) => app.inject({ method: 'DELETE', url: `/api/v1/desk/snoozes/${encodeURIComponent(key)}` });
  const hour = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const levelOf = (attention: readonly Snoozable[]): string =>
    attention.some((a) => a.severity === 'red') ? 'red' : attention.some((a) => a.severity === 'yellow') ? 'yellow' : 'green';
  afterEach(async () => {
    vi.restoreAllMocks();
    const left = (await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as { snoozes: Array<{ key: string }> };
    for (const s of left.snoozes) await wake(s.key);
  });

  it('an item a person may snooze carries its key and rank; a component (infra) item carries none', async () => {
    const { body } = await snapshot();
    const item = gateItem(body)!;
    // The open gate's interaction id and its opening (the engine's, from GET /interactions).
    expect(item.snooze).toEqual({ key: `attention:run:run-gate@ir_gate1@${new Date(gateOpenedAt).toISOString()}`, rank: 101 });
    for (const a of body.attention as Snoozable[]) if (a.source !== 'run') expect(a.snooze).toBeUndefined();
  });

  it('a snooze in force takes the item out of attention[] into snoozed[]; Wake brings it back', async () => {
    const before = (await snapshot()).body;
    const item = gateItem(before)!;
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await put(item.snooze!.key, { until, severity: item.snooze!.rank })).statusCode).toBe(200);
    const held = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
    expect(gateItem(held)).toBeUndefined();
    expect(held.attention.length).toBe(before.attention.length - 1);
    expect(held.snoozed).toEqual([expect.objectContaining({ id: 'run:run-gate', until, snooze: item.snooze })]);
    const woke = await app.inject({ method: 'DELETE', url: `/api/v1/desk/snoozes/${encodeURIComponent(item.snooze!.key)}` });
    expect(woke.statusCode).toBe(200);
    const back = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
    expect(gateItem(back)).toBeDefined();
    expect(back.snoozed).toEqual([]);
  });

  it('an item worse than when it was snoozed stays in attention[]', async () => {
    const item = gateItem((await snapshot()).body)!;
    expect((await put(item.snooze!.key, { until: new Date(Date.now() + 3_600_000).toISOString(), severity: item.snooze!.rank - 1 })).statusCode).toBe(200);
    const body = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
    expect(gateItem(body)).toBeDefined();
    expect(body.snoozed).toEqual([]);
    await app.inject({ method: 'DELETE', url: `/api/v1/desk/snoozes/${encodeURIComponent(item.snooze!.key)}` });
  });

  it('the level is the kept items\' worst: a snoozed item leaves it, and Wake puts it back', async () => {
    gateKind = 'escalation'; // the run is held: red, the worst on the page
    try {
      const before = (await snapshot()).body;
      const item = gateItem(before)!;
      expect(item.severity).toBe('red');
      expect(before.level).toBe('red');
      const rest = (before.attention as Snoozable[]).filter((a) => a.id !== item.id);
      expect(levelOf(rest)).not.toBe('red'); // the held gate is what makes the page red
      expect((await put(item.snooze!.key, { until: hour(), severity: item.snooze!.rank })).statusCode).toBe(200);
      const held = (await snapshot()).body;
      expect(gateItem(held)).toBeUndefined();
      expect(held.level).toBe(levelOf(rest));
      await wake(item.snooze!.key);
      expect((await snapshot()).body.level).toBe('red');
    } finally {
      gateKind = 'plan_approval';
    }
  });

  it('a snooze stored with no severity holds nothing back', async () => {
    const item = gateItem((await snapshot()).body)!;
    expect((await put(item.snooze!.key, { until: hour() })).statusCode).toBe(200);
    const body = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
    expect(gateItem(body)).toBeDefined();
    expect(body.snoozed).toEqual([]);
    await wake(item.snooze!.key);
  });

  it('the gate asked again (same interaction id, a new opening) is not held by the earlier snooze', async () => {
    const first = gateItem((await snapshot()).body)!;
    expect((await put(first.snooze!.key, { until: hour(), severity: first.snooze!.rank })).statusCode).toBe(200);
    expect(gateItem((await snapshot()).body)).toBeUndefined();
    const was = gateOpenedAt;
    gateOpenedAt = Date.now() - 1_000;
    try {
      const body = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
      const again = gateItem(body)!;
      expect(again).toBeDefined();
      expect(again.snooze!.key).not.toBe(first.snooze!.key);
      expect(body.snoozed).toEqual([]);
    } finally {
      gateOpenedAt = was;
      await wake(first.snooze!.key);
    }
  });

  it('a snooze read that fails holds nothing back, and the snapshot still answers', async () => {
    const item = gateItem((await snapshot()).body)!;
    expect((await put(item.snooze!.key, { until: hour(), severity: item.snooze!.rank })).statusCode).toBe(200);
    expect(gateItem((await snapshot()).body)).toBeUndefined(); // held while the read answers
    try {
      vi.spyOn(DeskSnoozes.prototype, 'list').mockRejectedValueOnce(new Error('trail unreadable'));
      const body = (await snapshot()).body as SystemSnapshot & { snoozed?: Held[] };
      expect(gateItem(body)!.snooze).toEqual(item.snooze);
      expect(body.snoozed).toEqual([]);
    } finally {
      await wake(item.snooze!.key);
    }
  });

  it('a snooze read that never settles holds nothing back, inside the budget', async () => {
    const item = gateItem((await snapshot()).body)!;
    expect((await put(item.snooze!.key, { until: hour(), severity: item.snooze!.rank })).statusCode).toBe(200);
    expect(gateItem((await snapshot()).body)).toBeUndefined(); // held while the read answers
    vi.spyOn(DeskSnoozes.prototype, 'list').mockImplementationOnce(() => new Promise(() => undefined));
    const { body, ms } = await snapshot();
    expect(gateItem(body)!.snooze).toEqual(item.snooze);
    expect((body as SystemSnapshot & { snoozed?: Held[] }).snoozed).toEqual([]);
    expect(ms).toBeLessThan(SYSTEM_BUDGET_MS + 1_000);
  }, 20_000);
});
