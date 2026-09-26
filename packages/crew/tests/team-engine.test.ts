// DES-TEAMING-002 seam T8 through the REAL engine on a real bus: the engine publishes every
// `wicked.team.*` fact (§4.0); crew relays them onto /ws as `teamEvent` frames, reads them back on
// `GET /runs/:id/team`, and submits the plan edit as a command. Skipped on an addon without
// `Core.runTeam` (the P1 read) or the plan approval gate (T3).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { crewBusHandle } from '../src/core/bus-handle.js';
import { createServer } from '../src/api/server.js';
import type {
  CatalogResponse,
  PlanPreviewResponse,
  PlanProposalResponse,
  RunTeamResponse,
  SessionView,
  TeamEventFrame,
} from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const probeDir = mkdtempSync(join(tmpdir(), 'team-probe-'));
const probe = new CoreAdapter({ dbPath: join(probeDir, 'core.db'), stub: true });
const ENGINE_HAS_TEAM_READ =
  typeof (probe as unknown as { core: { runTeam?: unknown } }).core.runTeam === 'function' && engineSupportsPlanLaunch();
// T8 (c)/(e): the catalog, the plan preview and the mid-run plan edit as engine bindings.
const ENGINE_HAS_T8_BINDINGS = ['catalog', 'previewPlan', 'proposePlan'].every(
  (m) => typeof (probe as unknown as { core: Record<string, unknown> }).core[m] === 'function',
);
probe.close();
removeScratch(probeDir);

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function waitFor<T>(what: string, probeFn: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const got = await probeFn();
    if (got !== undefined) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface BusRow {
  event_id: number;
  event_type: string;
  payload: string;
}

describe.skipIf(!ENGINE_HAS_TEAM_READ)('the team surface through the real engine and bus', () => {
  const savedBus = process.env['WICKED_BUS_DB'];
  let dir: string;
  let busPath: string;
  /** Crew's bus connections in this file: held, never closed (see beforeAll). */
  const held: unknown[] = [];
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl: string;
  let ws: WebSocket;
  const frames: Array<Record<string, unknown>> = [];

  const teamFrames = (run: string) =>
    frames.filter(
      (f): f is TeamEventFrame & Record<string, unknown> =>
        f['type'] === 'teamEvent' && (f as unknown as TeamEventFrame).event.payload.run_id === run,
    );
  const busRows = (run: string): BusRow[] =>
    crewBusHandle(busPath, { create: false })
      .prepare(
        `SELECT event_id, event_type, payload FROM events
          WHERE event_type LIKE 'wicked.team.%' AND json_extract(payload, '$.run_id') = ? ORDER BY event_id`,
      )
      .all(run) as BusRow[];

  async function viewOf(runId: string): Promise<SessionView | undefined> {
    return (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
  }

  async function launchHeld(sessionId: string, extra: Record<string, unknown> = {}): Promise<void> {
    const res = await fetch(
      `${baseUrl}/api/v1/runs`,
      json({ problem: 'add SSO login', sessionId, clisJson: SEATS, plan: { steps: [{ catalog: 'build' }] }, ...extra }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    await waitFor('the plan_approval pause', async () =>
      (await viewOf(sessionId))?.session.status === 'awaiting_human' ? true : undefined,
    );
  }

  beforeAll(async () => {
    baseSkillOff();
    dir = mkdtempSync(join(tmpdir(), 'team-engine-'));
    busPath = join(dir, 'bus.db');
    // The daemon's boot creates the bus (schema included) before the engine spawns, and HOLDS that
    // connection for the life of the process. Holding it is load-bearing: a dropped better-sqlite3
    // connection is closed when V8 collects it, and a close on this file, while the engine holds
    // it through its own SQLite copy, wins EXCLUSIVE (the engine's POSIX locks are invisible to
    // it), checkpoints and unlinks bus.db-wal under the engine. The engine then writes every team
    // fact into its unlinked WAL: it reports them published, nothing else ever sees them, and each
    // wait on a relayed frame or a bus row times out (crew main red after #675, F-E2E-021's class).
    held.push((await import('wicked-bus')).openDb({ db_path: busPath }));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true, busDbPath: busPath });
    app = await createServer(adapter, {
      auditPath: join(dir, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      teamWsRelay: { pollIntervalMs: 100 },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data: Buffer | string) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
  });

  afterAll(async () => {
    ws?.close();
    await app?.close();
    adapter?.close();
    removeScratch(dir);
    if (savedBus === undefined) delete process.env['WICKED_BUS_DB'];
    else process.env['WICKED_BUS_DB'] = savedBus;
  });

  it('(a)(f) every team row reaches /ws as teamEvent, tagged project_id; plan.proposed{by:"human"} precedes the first dispatch', async () => {
    const project = await adapter.projectCreate('t8-project');
    await launchHeld('t8-a', { projectId: project.id });
    await waitFor('the relayed plan.proposed', () =>
      teamFrames('t8-a').some((f) => f.event.event_type === 'wicked.team.plan.proposed') ? true : undefined,
    );
    // Every row on the bus for the run arrived, in event_id order, each tagged with the project.
    const rows = busRows('t8-a');
    await waitFor('every row relayed', () => (teamFrames('t8-a').length >= rows.length ? true : undefined));
    const relayed = teamFrames('t8-a');
    expect(relayed.map((f) => f.event.event_id)).toEqual(rows.map((r) => r.event_id));
    expect(relayed.every((f) => f.project_id === project.id)).toBe(true);
    const proposed = relayed.find((f) => f.event.event_type === 'wicked.team.plan.proposed')!;
    expect(proposed.event.payload.by).toBe('human');

    // Approve: the first unit dispatches only after the human plan fact.
    expect((await fetch(`${baseUrl}/api/v1/runs/t8-a/gate`, json({ approve: true }))).status).toBe(200);
    const claimed = await waitFor('the first step.claimed', () =>
      busRows('t8-a').find((r) => r.event_type === 'wicked.team.step.claimed'),
    );
    expect(proposed.event.event_id).toBeLessThan(claimed.event_id);
  });

  it('(b) the read route: transport, the run rows, every unit with its rows', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/t8-a/team`);
    expect(res.status, await res.clone().text()).toBe(200);
    const team = (await res.json()) as RunTeamResponse;
    expect(team.transport).toBe('bus');
    expect(team.planRev).toBe(1);
    expect(team.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['wicked.team.path.started', 'wicked.team.plan.proposed', 'wicked.team.plan.accepted']),
    );
    const all = [...team.rows, ...team.units.flatMap((u) => u.rows)].map((r) => r.event_id).sort((a, b) => a - b);
    // The engine keeps publishing for the running unit: compare up to the route's newest row.
    expect(all).toEqual(busRows('t8-a').map((r) => r.event_id).filter((id) => id <= Math.max(...all)));
    expect(team.units.length).toBeGreaterThan(0);
    expect(team.units[0]?.rows.map((r) => r.event_type)).toContain('wicked.team.step.claimed');

    // "The snapshot when the rows are gone" is pinned in team-surface.test.ts, where crew's library
    // is the bus file's only writer: deleting rows here, under a live engine writing the same file
    // through its own SQLite copy, is the two-library write that corrupts it (team-relay.test.ts).
  });

  it('(b) an un-teamed run answers units: []', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`, json({ problem: 'free text', sessionId: 't8-plain', clisJson: SEATS }));
    expect(res.status, await res.clone().text()).toBe(201);
    const team = (await (await fetch(`${baseUrl}/api/v1/runs/t8-plain/team`)).json()) as RunTeamResponse;
    expect(team.units).toEqual([]);
    expect(team.teamed).toBe(false);
    expect(team.transport).toBeNull();
  });

  it('(c) POST /runs/:id/plan: the engine publishes plan.proposed{by:"human", kind:"edit"} once; a repeat off the gate is the engine\'s refusal', async () => {
    await launchHeld('t8-c');
    let confirms = 0;
    const real = adapter.confirmGate.bind(adapter);
    adapter.confirmGate = (...args: Parameters<CoreAdapter['confirmGate']>) => {
      confirms++;
      return real(...args);
    };
    const body = { plan: { steps: [{ catalog: 'build', id: 'make' }, { catalog: 'test', id: 'prove' }] } };
    const first = await fetch(`${baseUrl}/api/v1/runs/t8-c/plan`, json(body));
    expect(first.status, await first.clone().text()).toBe(200);
    const edits = () =>
      busRows('t8-c').filter((r) => {
        const p = JSON.parse(r.payload) as { by?: string; kind?: string };
        return r.event_type === 'wicked.team.plan.proposed' && p.by === 'human' && p.kind === 'edit';
      });
    await waitFor('the edit fact', () => (edits().length === 1 ? true : undefined));
    expect(confirms).toBe(1);
    // The gate is answered and the run moved on: the repeat is a mid-run edit (proposePlan), and
    // the engine refuses it (the plan already has those steps, or the run already finished).
    const again = await fetch(`${baseUrl}/api/v1/runs/t8-c/plan`, json(body));
    expect(again.status, await again.clone().text()).toBe(409);
    expect(confirms).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(edits()).toHaveLength(1);
  });

  it.skipIf(!ENGINE_HAS_T8_BINDINGS)('(e) GET /catalog: the engine catalog, every entry in its exact shape', async () => {
    const res = await fetch(`${baseUrl}/api/v1/catalog`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { entries } = (await res.json()) as CatalogResponse;
    expect(entries.length).toBeGreaterThan(0);
    const keys = [
      'description', 'evidence_floor', 'executes_code', 'executor', 'gate', 'gate_type', 'id', 'kind', 'pinned',
      'role', 'skill_ref', 'validator_pin',
    ];
    // `verified_evidence` (wicked-core catalog-verified-evidence; api-types 0.46.0) is additive: an
    // engine that carries it carries it on every entry, and it names exactly the entries whose step
    // is an acceptance requirement (crew#683 reads it for a plan run's acceptance).
    const flagged = entries.some((e) => 'verified_evidence' in e);
    const want = flagged ? [...keys, 'verified_evidence'].sort() : keys;
    for (const e of entries) expect(Object.keys(e).sort(), e.id).toEqual(want);
    if (flagged) {
      expect(entries.filter((e) => e.verified_evidence === true).map((e) => e.id)).toEqual(['test', 'domain_coverage']);
    }
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(['understand', 'build', 'review', 'deliver']));
    const deliver = entries.find((e) => e.id === 'deliver')!;
    expect(deliver.executor).toBe('tool');
    const build = entries.find((e) => e.id === 'build')!;
    expect(build).toMatchObject({ role: 'creator', executes_code: true, executor: 'agent', pinned: true, evidence_floor: true });
    expect(build.validator_pin).toEqual(expect.any(String));
  });

  it.skipIf(!ENGINE_HAS_T8_BINDINGS)('(e) POST /plans/preview: the launch decision in the engine shape; floor steps are marked; nothing is launched', async () => {
    const before = (await adapter.sessionsDetail()).length;
    const res = await fetch(`${baseUrl}/api/v1/plans/preview`, json({ plan: { steps: [{ catalog: 'build' }] } }));
    expect(res.status, await res.clone().text()).toBe(200);
    const p = (await res.json()) as PlanPreviewResponse;
    expect(Object.keys(p).sort()).toEqual([
      'band', 'def', 'destructive', 'deterministic', 'floor', 'floor_override', 'graph', 'high_risk', 'pause_reason',
      'pauses', 'reasons', 'score', 'steps',
    ]);
    // No declared scope: the fail-closed score, high risk, and the launch would pause for approval.
    expect(p.graph).toBe('unavailable');
    expect(p.high_risk).toBe(true);
    expect(p.pauses).toBe(true);
    expect(p.pause_reason).toBe('high_risk');
    const added = p.steps.filter((s) => s.added_by === 'floor');
    expect(added.length).toBeGreaterThan(0);
    for (const s of added) expect(s.floor_reason, s.id).toEqual(expect.any(String));
    expect(p.steps.find((s) => s.catalog === 'build')?.added_by).toBe('plan');
    expect(p.def.phases.map((ph) => ph.id)).toEqual(p.steps.map((s) => s.id));
    expect((await adapter.sessionsDetail()).length).toBe(before);
  });

  it.skipIf(!ENGINE_HAS_T8_BINDINGS)('(e) POST /plans/preview: deliver "pr" puts the launch deliver step in the floor; a refused draft and an unknown repo are 400s', async () => {
    const delivered = await fetch(`${baseUrl}/api/v1/plans/preview`, json({ plan: { steps: [{ catalog: 'build' }] }, deliver: 'pr' }));
    expect(delivered.status, await delivered.clone().text()).toBe(200);
    const p = (await delivered.json()) as PlanPreviewResponse;
    expect(p.floor).toContain('deliver');
    expect(p.steps.at(-1)).toMatchObject({ catalog: 'deliver', id: 'deliver' });

    const refused = await fetch(`${baseUrl}/api/v1/plans/preview`, json({ plan: { steps: [{ catalog: 'nope' }] } }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/nope/);
    const unknownRepo = await fetch(
      `${baseUrl}/api/v1/plans/preview`,
      json({ plan: { steps: [{ catalog: 'build' }] }, repoRef: 'no-such-repo' }),
    );
    expect(unknownRepo.status).toBe(400);
    expect(((await unknownRepo.json()) as { error: string }).error).toMatch(/no-such-repo/);
  });

  it.skipIf(!ENGINE_HAS_T8_BINDINGS)('(c) POST /runs/:id/plan mid-run: proposePlan holds the edit and answers its band; a repeated requestId is a duplicate; refusals are 409s', async () => {
    // Past its plan gate and running: the plan is accepted and the first step claimed.
    await launchHeld('t8-mid');
    expect((await fetch(`${baseUrl}/api/v1/runs/t8-mid/gate`, json({ approve: true }))).status).toBe(200);
    await waitFor('the run past its plan gate', async () =>
      busRows('t8-mid').some((r) => r.event_type === 'wicked.team.step.claimed') &&
      (await viewOf('t8-mid'))?.session.status === 'executing'
        ? true
        : undefined,
    );
    const edit = { plan: { steps: [{ catalog: 'review', id: 'second-look' }] }, requestId: 'mid-1' };
    const res = await fetch(`${baseUrl}/api/v1/runs/t8-mid/plan`, json(edit));
    expect(res.status, await res.clone().text()).toBe(200);
    const proposal = (await res.json()) as PlanProposalResponse;
    expect(Object.keys(proposal).sort()).toEqual(['band', 'duplicate', 'floor_added', 'high_risk', 'proposal_id']);
    expect(proposal.duplicate).toBe(false);
    expect(proposal.proposal_id).toEqual(expect.any(String));
    expect(proposal.band).toEqual(expect.any(String));
    expect(typeof proposal.high_risk).toBe('boolean');
    expect(Array.isArray(proposal.floor_added)).toBe(true);

    const again = await fetch(`${baseUrl}/api/v1/runs/t8-mid/plan`, json(edit));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...proposal, duplicate: true, band: null, high_risk: null, floor_added: [] });

    // An edit that carries `touch` belongs to the launch plan: the engine refuses it, 409 with its reason.
    const touched = await fetch(
      `${baseUrl}/api/v1/runs/t8-mid/plan`,
      json({ plan: { steps: [{ catalog: 'test' }], touch: ['src/a.ts'] }, requestId: 'mid-2' }),
    );
    expect(touched.status).toBe(409);
    expect(((await touched.json()) as { error: string }).error).toMatch(/touch/);

    // A finished run's plan no longer changes.
    expect((await fetch(`${baseUrl}/api/v1/runs/t8-mid/cancel`, { method: 'POST' })).status).toBe(200);
    await waitFor('the cancel', async () => ((await viewOf('t8-mid'))?.session.status === 'cancelled' ? true : undefined));
    const finished = await fetch(`${baseUrl}/api/v1/runs/t8-mid/plan`, json({ ...edit, requestId: 'mid-3' }));
    expect(finished.status).toBe(409);
    expect(((await finished.json()) as { error: string }).error).toMatch(/finished/);
  });
});
