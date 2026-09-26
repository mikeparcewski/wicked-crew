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
import type { RunTeamResponse, SessionView, TeamEventFrame } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const probeDir = mkdtempSync(join(tmpdir(), 'team-probe-'));
const probe = new CoreAdapter({ dbPath: join(probeDir, 'core.db'), stub: true });
const ENGINE_HAS_TEAM_READ =
  typeof (probe as unknown as { core: { runTeam?: unknown } }).core.runTeam === 'function' && engineSupportsPlanLaunch();
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

async function waitFor<T>(what: string, probeFn: () => Promise<T | undefined> | T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
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
    // TEMP DIAG: a watchdog that dumps what it can WITHOUT the actor while the launch hangs.
    let step = 'fetch POST /runs';
    const t0 = Date.now();
    const dog = setInterval(() => {
      void (async () => {
        const { readdirSync, readFileSync, existsSync } = await import('node:fs');
        const safe = (f: () => unknown) => { try { return f(); } catch (x) { return String(x); } };
        const race = <T,>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT(2s)'), 2000))]);
        console.error('T8WATCH', JSON.stringify({
          sessionId, step, elapsed: Date.now() - t0,
          rows: safe(() => busRows(sessionId).map((r) => r.event_type)),
          allTeamRows: safe(() => crewBusHandle(busPath, { create: false }).prepare("SELECT count(*) AS n FROM events").all()),
          dir: safe(() => readdirSync(dir)),
          outbox: safe(() => (existsSync(join(dir, 'team-outbox.ndjson')) ? readFileSync(join(dir, 'team-outbox.ndjson'), 'utf8').slice(0, 2000) : 'none')),
          bridge: safe(() => (adapter as unknown as { core: { busBridgeState(): string } }).core.busBridgeState()),
          view: await race((async () => { const v = await viewOf(sessionId); return v ? [v.session.status, v.units.map((u) => u.status)] : 'no view'; })()),
          team: await race(adapter.runTeam(sessionId).catch((x) => String(x))),
        }));
      })();
    }, 7000);
    try {
      await launchHeldInner(sessionId, extra, (s) => { step = s; });
    } finally {
      clearInterval(dog);
    }
  }

  async function launchHeldInner(sessionId: string, extra: Record<string, unknown>, mark: (s: string) => void): Promise<void> {
    const res = await fetch(
      `${baseUrl}/api/v1/runs`,
      json({ problem: 'add SSO login', sessionId, clisJson: SEATS, plan: { steps: [{ catalog: 'build' }] }, ...extra }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    mark('waiting for awaiting_human');
    try {
      await waitFor('the plan_approval pause', async () =>
        (await viewOf(sessionId))?.session.status === 'awaiting_human' ? true : undefined,
        20_000,
      );
    } catch (e) {
      // TEMP DIAG (crew main red after #675): what the engine is doing when the pause never comes.
      const v = await viewOf(sessionId);
      const safe = async (f: () => unknown) => { try { return await f(); } catch (x) { return String(x); } };
      const { readdirSync, readFileSync, existsSync } = await import('node:fs');
      console.error('T8DIAG', JSON.stringify({
        sessionId,
        status: v?.session.status,
        units: v?.units.map((u) => [u.id, u.status]),
        team: await safe(() => adapter.runTeam(sessionId)),
        bridge: await safe(() => (adapter as unknown as { core: { busBridgeState(): string } }).core.busBridgeState()),
        open: await safe(() => adapter.interactionRequests(sessionId, 'open')),
        rows: await safe(() => busRows(sessionId).map((r) => r.event_type)),
        quick: await safe(() => crewBusHandle(busPath, { create: false }).prepare('PRAGMA quick_check').all()),
        dir: await safe(() => readdirSync(dir)),
        outbox: await safe(() => (existsSync(join(dir, 'team-outbox.ndjson')) ? readFileSync(join(dir, 'team-outbox.ndjson'), 'utf8').slice(0, 3000) : 'none')),
        events: await safe(async () => (await adapter.runEvents(sessionId))?.map((e) => (e as { type?: string }).type)),
      }));
      throw e;
    }
  }

  beforeAll(async () => {
    baseSkillOff();
    dir = mkdtempSync(join(tmpdir(), 'team-engine-'));
    busPath = join(dir, 'bus.db');
    // The daemon's boot creates the bus (schema included) before the engine spawns.
    (await import('wicked-bus')).openDb({ db_path: busPath });
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
    console.error('T8STEP projectCreate start', Date.now());
    const project = await adapter.projectCreate('t8-project');
    console.error('T8STEP projectCreate done', Date.now());
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

  it('(c) POST /runs/:id/plan: the engine publishes plan.proposed{by:"human", kind:"edit"} once; a repeat off the gate never reaches the engine', async () => {
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
    // The gate is answered and the run moved on: crew refuses the repeat itself (a mid-run edit is
    // the engine's proposePlan, not in core-ts yet) — the engine is never asked twice.
    const again = await fetch(`${baseUrl}/api/v1/runs/t8-c/plan`, json(body));
    expect(again.status).toBe(501);
    expect(confirms).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(edits()).toHaveLength(1);
  });
});
