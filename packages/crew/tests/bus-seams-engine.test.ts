// crew#679 through the REAL engine on a real bus: crew's migrated seams run beside the engine's
// team publishing without writing the bus through crew's own SQLite.
//
// The daemon's bus file is the engine's too (DES-TEAMING-002 T0). Before crew#679 the project bus
// and the interactive /ws relay armed wicked-bus `subscribe` (register + ack per row) and `emit`
// through better-sqlite3 on that file while the engine wrote it through its bundled SQLite: two
// SQLite copies in one process, whose POSIX locks do not exclude each other, so the concurrent
// writes corrupted it (crew#676 saw 1 of 3 buses malformed with a subscribing relay armed). That is
// why tests/team-engine.test.ts runs with both seams OFF.
//
// Here both are ON, beside the team relay, while plan launches make the engine publish team facts
// and crew emits project/membership/interactive events through the one bus writer. Pinned:
//   - every plan launch reaches its plan_approval gate (the engine's bus stayed writable);
//   - every interactive event crew emitted comes back through the read-only tap as a /ws frame,
//     in order, and the project events landed on the bus;
//   - the bus passes `quick_check`, and crew registered nothing: no subscription, cursor, delivery
//     or dead-letter row.
// Skipped on an addon without `Core.runTeam` or the plan approval gate, as team-engine is.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { crewBusHandle } from '../src/core/bus-handle.js';
import { createServer } from '../src/api/server.js';
import type { SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const probeDir = mkdtempSync(join(tmpdir(), 'bus-seams-probe-'));
const probe = new CoreAdapter({ dbPath: join(probeDir, 'core.db'), stub: true });
const ENGINE_HAS_TEAM =
  typeof (probe as unknown as { core: { runTeam?: unknown } }).core.runTeam === 'function' && engineSupportsPlanLaunch();
probe.close();
removeScratch(probeDir);

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);
const LAUNCHES = 6;
const EMITS_PER_LAUNCH = 5;

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

describe.skipIf(!ENGINE_HAS_TEAM)('crew seams beside the real engine on one bus (crew#679)', () => {
  const savedBus = process.env['WICKED_BUS_DB'];
  let dir: string;
  let busPath: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl: string;
  let ws: WebSocket;
  const frames: Array<Record<string, unknown>> = [];

  const count = (sql: string): number => {
    try {
      return (crewBusHandle(busPath, { create: false }).prepare(sql).all()[0] as { n: number }).n;
    } catch (err) {
      if (err instanceof Error && /no such table/.test(err.message)) return 0;
      throw err;
    }
  };

  async function viewOf(runId: string): Promise<SessionView | undefined> {
    return (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
  }

  beforeAll(async () => {
    baseSkillOff();
    dir = mkdtempSync(join(tmpdir(), 'bus-seams-engine-'));
    busPath = join(dir, 'bus.db');
    // As `serve` boots: crew's one long-lived handle opens (and creates) the bus BEFORE the engine
    // spawns, and is never closed. Nothing else in crew opens the file.
    crewBusHandle(busPath, { create: true });
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true, busDbPath: busPath });
    app = await createServer(adapter, {
      auditPath: join(dir, 'audit.log'),
      projectEvents: { dbPath: busPath, pollIntervalMs: 50 },
      interactiveWsRelay: { dbPath: busPath, pollIntervalMs: 50 },
      teamWsRelay: { pollIntervalMs: 50 },
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

  it('plan launches reach their gate while crew emits and taps the same bus; crew writes nothing through its SQLite', async () => {
    const created = await fetch(`${baseUrl}/api/v1/projects`, json({ name: 'bus-679' }));
    expect(created.status, await created.clone().text()).toBe(201);
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;

    // Launches (engine team facts + crew membership.attached) interleaved with UI emits.
    const emitted: string[] = [];
    await Promise.all(
      Array.from({ length: LAUNCHES }, async (_, i) => {
        const launch = fetch(
          `${baseUrl}/api/v1/runs`,
          json({ problem: `bus 679 #${i}`, sessionId: `b679-${i}`, clisJson: SEATS, projectId, plan: { steps: [{ catalog: 'build' }] } }),
        );
        for (let k = 0; k < EMITS_PER_LAUNCH; k++) {
          const res = await fetch(
            `${baseUrl}/api/v1/projects/${projectId}/interactive-events`,
            json({ type: 'wicked.interactive.status.requested', payload: { document_id: `doc-${i}-${k}` } }),
          );
          expect(res.status, await res.clone().text()).toBe(202);
          emitted.push(`doc-${i}-${k}`);
        }
        const res = await launch;
        expect(res.status, await res.clone().text()).toBe(201);
      }),
    );

    // The engine's bus stayed writable: every launch published its plan and paused at the gate.
    for (let i = 0; i < LAUNCHES; i++) {
      await waitFor(`b679-${i} at plan_approval`, async () =>
        (await viewOf(`b679-${i}`))?.session.status === 'awaiting_human' ? true : undefined,
      );
    }

    // Every emit came back through the read-only tap, in the order the writer landed them.
    const relayedDocs = (): string[] =>
      frames
        .filter((f) => f['type'] === 'interactiveEvent')
        .map((f) => ((f['event'] as { payload: { document_id?: string } }).payload.document_id ?? ''))
        .filter((d) => d.startsWith('doc-'));
    await waitFor('every interactive emit relayed', () => (relayedDocs().length >= emitted.length ? true : undefined));
    expect([...relayedDocs()].sort()).toEqual([...emitted].sort());
    const ids = frames
      .filter((f) => f['type'] === 'interactiveEvent')
      .map((f) => (f['event'] as { event_id: number }).event_id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // The project events crew emitted landed, beside the engine's team facts.
    await waitFor('the membership rows', () =>
      count(`SELECT count(*) AS n FROM events WHERE event_type = 'wicked.crew.membership.attached'`) >= LAUNCHES ? true : undefined,
    );
    expect(count(`SELECT count(*) AS n FROM events WHERE event_type = 'wicked.crew.project.created'`)).toBe(1);
    expect(count(`SELECT count(*) AS n FROM events WHERE event_type LIKE 'wicked.team.%'`)).toBeGreaterThan(0);
    expect(frames.some((f) => f['type'] === 'teamEvent')).toBe(true);

    // The file is sound, and no crew seam registered, acked or dead-lettered anything on it.
    expect(crewBusHandle(busPath, { create: false }).pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    for (const table of ['subscriptions', 'cursors', 'delivery_attempts', 'dead_letters']) {
      expect(count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
  });
});
