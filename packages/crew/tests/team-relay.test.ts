// DES-TEAMING-002 §4.5 — the teamEvent relay READS the bus and never writes it.
//
// The bus file is the engine's too (T0: the daemon hands the engine the same file). The engine
// writes it through its bundled SQLite (rusqlite) while crew holds it through better-sqlite3: two
// SQLite copies in one process, whose POSIX locks do not exclude each other (a process never
// conflicts with its own fcntl locks — sqlite.org/howtocorrupt.html §2.2.1). A crew-side WRITE
// concurrent with an engine write corrupts the file. crew#675 armed the relay through wicked-bus
// `subscribe`, which registers a subscription and acks a durable cursor on every event: under the
// engine's team publishing that corrupted the bus ("database disk image is malformed", quick_check
// "wrong # of entries in index"), the engine spooled its required facts to the outbox and plan
// launches never reached their gate (crew main 3d203e8, tests/team-engine.test.ts timeouts).
//
// So the relay polls through crew's one long-lived handle, keeps its cursor in memory (it starts
// at the newest row: `latest`, as before), and issues no write at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crewBusHandle } from '../src/core/bus-handle.js';
import { startTeamWsRelay, type TeamRelay } from '../src/team/ws-relay.js';
import { removeScratch } from './setup/scratch.js';

type Frame = { type: string; event: { event_id: number; event_type: string; payload: Record<string, unknown> }; project_id?: string };

let dir: string;
let busPath: string;
let relay: TeamRelay | null;

async function emitRows(rows: Array<{ type: string; run: string }>) {
  const bus = await import('wicked-bus');
  const override = { db_path: busPath };
  const config = bus.loadConfig(override);
  const db = bus.openDb(override);
  for (const r of rows) {
    bus.emit(db, config, {
      event_type: r.type,
      domain: 'core-fixture',
      subdomain: 'core.team',
      payload: { run_id: r.run, ord: null, attempt: null, by: 'engine', at: 1, re: null },
      producer_id: 'core-fixture',
      idempotency_key: `${r.type}-${r.run}-${Math.random()}`,
    });
  }
}

async function until<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== undefined) return got;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

/** Every row count the relay could have written through a wicked-bus subscription. */
function writeFootprint(): Record<string, number> {
  const db = crewBusHandle(busPath, { create: false });
  const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).all()[0] as { n: number }).n;
  return { subscriptions: count('subscriptions'), cursors: count('cursors'), delivery_attempts: count('delivery_attempts') };
}

describe('the team relay (read-only)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-relay-'));
    busPath = join(dir, 'bus.db');
    relay = null;
    await emitRows([{ type: 'wicked.team.path.started', run: 'before' }]);
  });

  afterEach(async () => {
    await relay?.stop();
    removeScratch(dir);
  });

  it('relays new team rows in event_id order, tagged project_id, from the newest row on (latest)', async () => {
    const frames: Frame[] = [];
    relay = await startTeamWsRelay({
      dbPath: busPath,
      projectOf: (run) => (run === 'r1' ? 'p1' : undefined),
      pollIntervalMs: 10,
      broadcast: (f) => frames.push(f as unknown as Frame),
    });
    expect(relay).not.toBeNull();
    await emitRows([
      { type: 'wicked.team.path.started', run: 'r1' },
      { type: 'wicked.interactive.status.posted', run: 'r1' },
      { type: 'wicked.team.plan.proposed', run: 'r2' },
    ]);
    await until(() => (frames.length === 2 ? true : undefined));
    expect(frames.map((f) => [f.type, f.event.event_type, f.event.payload['run_id'], f.project_id])).toEqual([
      ['teamEvent', 'wicked.team.path.started', 'r1', 'p1'],
      ['teamEvent', 'wicked.team.plan.proposed', 'r2', undefined],
    ]);
    expect(frames[0]!.event.event_id).toBeLessThan(frames[1]!.event.event_id);
  });

  it('writes nothing to the bus: no subscription, no cursor, no delivery row', async () => {
    const before = writeFootprint();
    const frames: Frame[] = [];
    relay = await startTeamWsRelay({ dbPath: busPath, projectOf: () => undefined, pollIntervalMs: 10, broadcast: (f) => frames.push(f as unknown as Frame) });
    await emitRows([{ type: 'wicked.team.path.started', run: 'r1' }, { type: 'wicked.team.path.ended', run: 'r1' }]);
    // Many poll intervals: every row has been seen (and, through a subscription, acked).
    await new Promise((r) => setTimeout(r, 300));
    expect(writeFootprint()).toEqual(before);
  });

  it('a bus that is not there yet is null (logged), never a throw', async () => {
    const lines: string[] = [];
    const r = await startTeamWsRelay({ dbPath: join(dir, 'absent', 'bus.db'), projectOf: () => undefined, log: (m) => lines.push(m) });
    expect(r).toBeNull();
    expect(lines.join('\n')).toMatch(/team-relay/);
  });
});
