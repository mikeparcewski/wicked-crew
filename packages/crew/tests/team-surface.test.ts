// DES-TEAMING-002 seam T8, the crew team surface — the HTTP contract over a real adapter whose
// napi calls are shadowed (what crew reads, what it hands the engine, and the 501 on an addon
// without a binding). The engine end to end is tests/team-engine.test.ts.
//
//   GET  /runs/:id/team          the engine's snapshot (`Core.runTeam`) + the run's bus rows (T8 (b))
//   POST /runs/:id/plan          a plan edit at a plan_approval gate (T8 (c), T3)
//   POST /runs/:id/gate          team_transport and team_dispute answers (T8 (d), P1)
//   POST /team/outbox/replay     `Core.replayTeamOutbox` (P1)
//   GET  /catalog                `Core.catalog` (T8)
//   POST /plans/preview          `Core.previewPlan` (T8 (e))
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { RunTeamResponse, SessionView, TeamLedger } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function boot(name: string, busDbPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  // The bus file the engine publishes on (the adapter's WICKED_BUS_DB), without handing the
  // shadowed engine a bus.
  if (busDbPath !== undefined) Object.defineProperty(adapter, 'busDbPath', { value: busDbPath });
  const app = await createServer(adapter, {
    auditPath: join(dir, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { dir, adapter, app, baseUrl };
}

/** Shadow a napi method with an own property (delete would silently keep the real one). */
function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

/** Remove a napi method for the "older addon" case. */
function dropCore(a: CoreAdapter, name: string) {
  stubCore(a, name, undefined);
}

function runs(a: CoreAdapter, rows: Array<{ id: string; status: string }>) {
  a.sessionsDetail = async () =>
    rows.map((r) => ({ session: { id: r.id, status: r.status }, units: [] })) as unknown as SessionView[];
}

const LEDGER: TeamLedger = {
  finalPass: 'completed',
  renderedToJudge: true,
  teamPause: false,
  monitors: [],
  findings: [],
  rejected: { malformed: 0, belowBar: 0, unconfirmed: 0, duplicate: 0 },
};

const SNAPSHOT = {
  runId: 'r1',
  transport: 'bus',
  reason: null,
  streamFloor: 1,
  planRev: 1,
  pending: null,
  ended: false,
  units: [
    { ord: 1, transport: 'bus', reason: null, ledgerSource: 'folded', ledgerRef: 'ledger.folded#1:0', finalPass: 'completed', teamPause: false, findings: 0 },
    { ord: 2, transport: 'bus', reason: null, ledgerSource: 'synthesized', ledgerRef: null, finalPass: 'timed_out', teamPause: true, findings: 0 },
  ],
};

const env = (run: string, ord: number | null, attempt: number | null) => ({
  run_id: run,
  ord,
  attempt,
  by: 'engine',
  at: 1,
  re: null,
});

/** Put team rows on a scratch bus, as the engine would (tests may emit; crew's src may not). */
async function seedBus(busPath: string, rows: Array<{ type: string; payload: Record<string, unknown> }>) {
  const bus = await import('wicked-bus');
  const override = { db_path: busPath };
  const config = bus.loadConfig(override);
  const db = bus.openDb(override);
  let n = 0;
  for (const r of rows) {
    bus.emit(db, config, {
      event_type: r.type,
      domain: 'wicked-core',
      subdomain: 'core.team',
      payload: r.payload,
      producer_id: 'wicked-core',
      idempotency_key: `seed-${busPath}-${n++}`,
    });
  }
  return db;
}

describe('GET /runs/:id/team (T8 (b))', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let busPath: string;

  beforeEach(async () => {
    const busDir = mkdtempSync(join(tmpdir(), 'team-bus-'));
    busPath = join(busDir, 'bus.db');
    ctx = await boot('team-read', busPath);
    runs(ctx.adapter, [{ id: 'r1', status: 'executing' }, { id: 'plain', status: 'completed' }]);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('404 for an unknown run', async () => {
    stubCore(ctx.adapter, 'runTeam', () => Promise.reject(new Error('unknown run nope')));
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/nope/team`);
    expect(res.status).toBe(404);
  });

  it('an un-teamed run answers transport "none" with units: []', async () => {
    stubCore(ctx.adapter, 'runTeam', () => Promise.resolve('null'));
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/plain/team`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunTeamResponse;
    expect(body).toEqual({
      runId: 'plain',
      transport: 'none',
      reason: 'not a team run',
      streamFloor: null,
      planRev: null,
      pending: null,
      ended: false,
      units: [],
      rows: [],
    });
  });

  it('the attempt rows by event_id with the folded ledger; a late fold is labelled unused', async () => {
    await seedBus(busPath, [
      { type: 'wicked.team.path.started', payload: { ...env('r1', null, null), cli: 'alpha' } },
      { type: 'wicked.team.step.claimed', payload: { ...env('r1', 1, 0), step_id: 'build' } },
      { type: 'wicked.team.ledger.folded', payload: { ...env('r1', 1, 0), final_pass: 'completed', ledger: LEDGER } },
      { type: 'wicked.team.gate.opened', payload: { ...env('r1', 1, 0), gate_id: 'g1', kind: 'unit_review', ledger_ref: 'ledger.folded#1:0', ledger_source: 'folded' } },
      // Unit 2: the worker synthesized its ledger at the final-pass deadline; S's fold landed late.
      { type: 'wicked.team.gate.opened', payload: { ...env('r1', 2, 0), gate_id: 'g2', kind: 'unit_review', ledger_ref: null, ledger_source: 'synthesized' } },
      { type: 'wicked.team.ledger.folded', payload: { ...env('r1', 2, 0), final_pass: 'completed', ledger: LEDGER } },
      // Another run's row never shows up here.
      { type: 'wicked.team.path.started', payload: { ...env('other', null, null), cli: 'alpha' } },
    ]);
    stubCore(ctx.adapter, 'runTeam', () => Promise.resolve(JSON.stringify(SNAPSHOT)));
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/team`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as RunTeamResponse;
    expect(body.transport).toBe('bus');
    expect(body.rows.map((r) => r.event_type)).toEqual(['wicked.team.path.started']);
    const [u1, u2] = body.units;
    expect(u1?.rows.map((r) => r.event_type)).toEqual([
      'wicked.team.step.claimed',
      'wicked.team.ledger.folded',
      'wicked.team.gate.opened',
    ]);
    const ids = u1!.rows.map((r) => r.event_id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(u1?.ledger).toEqual(LEDGER);
    expect(u1?.rows.some((r) => r.unused === true)).toBe(false);
    // The snapshot fields are the engine's, verbatim.
    expect(u1).toMatchObject(SNAPSHOT.units[0]!);
    expect(u2?.ledger).toBeNull();
    const late = u2?.rows.find((r) => r.event_type === 'wicked.team.ledger.folded');
    expect(late?.unused).toBe(true);
  });

  it('the persisted snapshot when the bus has no rows (rows deleted)', async () => {
    const db = await seedBus(busPath, [
      { type: 'wicked.team.ledger.folded', payload: { ...env('r1', 1, 0), final_pass: 'completed', ledger: LEDGER } },
    ]);
    db.prepare(`DELETE FROM events WHERE event_type LIKE 'wicked.team.%'`).run();
    stubCore(ctx.adapter, 'runTeam', () => Promise.resolve(JSON.stringify(SNAPSHOT)));
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/team`);
    const body = (await res.json()) as RunTeamResponse;
    expect(body.rows).toEqual([]);
    expect(body.units.map((u) => ({ ...u }))).toEqual(
      SNAPSHOT.units.map((u) => ({ ...u, rows: [], ledger: null })),
    );
  });

  it('a daemon with no bus serves the snapshot alone', async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
    ctx = await boot('team-read-nobus');
    runs(ctx.adapter, [{ id: 'r1', status: 'awaiting_human' }]);
    const view = { ...SNAPSHOT, transport: 'unavailable', reason: 'no bus', pending: 'wicked.team.path.started' };
    stubCore(ctx.adapter, 'runTeam', () => Promise.resolve(JSON.stringify(view)));
    const body = (await (await fetch(`${ctx.baseUrl}/api/v1/runs/r1/team`)).json()) as RunTeamResponse;
    expect(body.transport).toBe('unavailable');
    expect(body.reason).toBe('no bus');
    expect(body.pending).toBe('wicked.team.path.started');
    expect(body.units.every((u) => u.rows.length === 0 && u.ledger === null)).toBe(true);
  });

  it('501 on an addon without Core.runTeam', async () => {
    dropCore(ctx.adapter, 'runTeam');
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/team`);
    expect(res.status).toBe(501);
  });
});

describe('commands (T8 (c), (d), P1)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let gated: unknown[][];

  beforeEach(async () => {
    ctx = await boot('team-cmd');
    gated = [];
    stubCore(ctx.adapter, 'confirmGate', (...args: unknown[]) => {
      gated.push(args);
      return Promise.resolve('executing');
    });
    ctx.adapter.supportsPlanLaunch = () => true;
    runs(ctx.adapter, [{ id: 'r1', status: 'awaiting_human' }, { id: 'busy', status: 'executing' }]);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('POST /runs/:id/plan answers the plan_approval gate with the edit (confirmGate edit_plan)', async () => {
    const plan = { steps: [{ catalog: 'build', id: 'make' }], touch: ['src/a.ts'] };
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/plan`, json({ plan }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ status: 'executing' });
    expect(gated).toHaveLength(1);
    const [runId, approve, amend, action, scope, planJson] = gated[0]!;
    expect([runId, approve, amend, action, scope]).toEqual(['r1', true, undefined, 'edit_plan', undefined]);
    expect(JSON.parse(planJson as string)).toEqual(plan);
  });

  it('POST /runs/:id/plan: 404 unknown, 409 not at a gate, 409 an engine refusal, 400 a bad body, 501 no plan gate', async () => {
    expect((await fetch(`${ctx.baseUrl}/api/v1/runs/nope/plan`, json({ plan: { steps: [{ catalog: 'build' }] } }))).status).toBe(404);
    expect((await fetch(`${ctx.baseUrl}/api/v1/runs/busy/plan`, json({ plan: { steps: [{ catalog: 'build' }] } }))).status).toBe(409);
    expect((await fetch(`${ctx.baseUrl}/api/v1/runs/r1/plan`, json({ plan: { steps: [] } }))).status).toBe(400);
    expect((await fetch(`${ctx.baseUrl}/api/v1/runs/r1/plan`, json({ plan: { steps: [{ catalog: 'build' }] }, x: 1 }))).status).toBe(400);
    expect(gated).toHaveLength(0);
    stubCore(ctx.adapter, 'confirmGate', () =>
      Promise.reject(new Error('run r1 has no plan_approval gate open — an edited plan answers only a plan approval gate')),
    );
    const refused = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/plan`, json({ plan: { steps: [{ catalog: 'build' }] } }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/plan_approval/);
    ctx.adapter.supportsPlanLaunch = () => false;
    expect((await fetch(`${ctx.baseUrl}/api/v1/runs/r1/plan`, json({ plan: { steps: [{ catalog: 'build' }] } }))).status).toBe(501);
  });

  it('a team_transport pause: approve, approve "continue without team", reject reach confirmGate as given', async () => {
    const answers = [
      { approve: true },
      { approve: true, amend: 'continue without team' },
      { approve: false },
    ];
    for (const a of answers) {
      const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json(a));
      expect(res.status, JSON.stringify(a)).toBe(200);
    }
    expect(gated).toEqual([
      ['r1', true, undefined],
      ['r1', true, 'continue without team'],
      ['r1', false, undefined],
    ]);
  });

  it('approving a team_dispute gate is a plain approve through confirmGate (never a re-dispatch here)', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json({ approve: true, action: 'approve' }));
    expect(res.status).toBe(200);
    expect(gated).toEqual([['r1', true, undefined, 'approve', undefined]]);
  });

  it('POST /team/outbox/replay answers the engine report; 409 when the engine refuses; 501 without the binding', async () => {
    const report = { published: [['k1', 7]], superseded: 1, invalid: 0, remaining: 0, failures: [] };
    stubCore(ctx.adapter, 'replayTeamOutbox', () => Promise.resolve(JSON.stringify(report)));
    const ok = await fetch(`${ctx.baseUrl}/api/v1/team/outbox/replay`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(report);
    stubCore(ctx.adapter, 'replayTeamOutbox', () => Promise.reject(new Error('the engine has no bus')));
    const refused = await fetch(`${ctx.baseUrl}/api/v1/team/outbox/replay`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/no bus/);
    dropCore(ctx.adapter, 'replayTeamOutbox');
    expect((await fetch(`${ctx.baseUrl}/api/v1/team/outbox/replay`, { method: 'POST' })).status).toBe(501);
  });
});

describe('GET /catalog and POST /plans/preview (T8 (e))', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    ctx = await boot('team-catalog');
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('GET /catalog answers the engine catalog', async () => {
    const entries = [{ id: 'understand', role: 'recon' }, { id: 'build', role: 'creator' }];
    stubCore(ctx.adapter, 'catalog', () => Promise.resolve(JSON.stringify(entries)));
    const res = await fetch(`${ctx.baseUrl}/api/v1/catalog`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries });
  });

  it('POST /plans/preview hands the draft to the engine and answers its floor fill verbatim', async () => {
    const seen: unknown[][] = [];
    const fill = {
      steps: [
        { catalog: 'test_plan', id: 'test_plan', added_by: 'floor', floor_reason: 'band 70-100 requires test_plan' },
        { catalog: 'build', id: 'build', added_by: 'plan' },
      ],
      added_by_floor: ['test_plan'],
      band: '70-100',
      high_risk: true,
    };
    stubCore(ctx.adapter, 'previewPlan', (...args: unknown[]) => {
      seen.push(args);
      return Promise.resolve(JSON.stringify(fill));
    });
    const plan = { steps: [{ catalog: 'build' }] };
    const res = await fetch(`${ctx.baseUrl}/api/v1/plans/preview`, json({ plan, projectId: 'p1', humanConfirm: 'before:1' }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual(fill);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]![0] as string)).toEqual(plan);
    expect(seen[0]!.slice(1)).toEqual(['p1', 'before:1']);
  });

  it('a refused draft is a 400 with the engine reason; a bad body a 400 that asks nothing', async () => {
    let calls = 0;
    stubCore(ctx.adapter, 'previewPlan', () => {
      calls++;
      return Promise.reject(new Error('plan_refused: unknown catalog entry `nope`'));
    });
    const refused = await fetch(`${ctx.baseUrl}/api/v1/plans/preview`, json({ plan: { steps: [{ catalog: 'nope' }] } }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/nope/);
    expect((await fetch(`${ctx.baseUrl}/api/v1/plans/preview`, json({ steps: [] }))).status).toBe(400);
    expect(calls).toBe(1);
  });

  it('501 on an addon without the catalog / preview bindings', async () => {
    dropCore(ctx.adapter, 'catalog');
    dropCore(ctx.adapter, 'previewPlan');
    expect((await fetch(`${ctx.baseUrl}/api/v1/catalog`)).status).toBe(501);
    expect((await fetch(`${ctx.baseUrl}/api/v1/plans/preview`, json({ plan: { steps: [{ catalog: 'build' }] } }))).status).toBe(501);
  });
});
