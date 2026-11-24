// crew#1124 (DES-desk-v2 §6 item 6): snooze a Needs-you item. The Desk's other five data asks are served
// (`/roster/record`); snooze was the one with no route, so a person could only answer or archive a need, never
// defer it. A snooze is a durable fact in the audit trail (`desk.need.snoozed` / `desk.need.woken`): it survives a
// restart, it ends by itself, and only a human operator sets or ends one (an agent cannot hide a need from a person).

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DeskSnooze, DeskSnoozesResponse } from 'wicked-crew-api-types';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { DESK_SNOOZE_MAX_MS, DeskSnoozes, registerDeskSnoozeRoutes } from '../src/api/desk-snoozes.js';

const AGENT: Actor = { id: 'seat-1', kind: 'agent', trust: 'operator' } as Actor;

let dir: string;
let audit: AuditLog;
let clock: number;
let app: FastifyInstance;
let actor: Actor | null;

async function serve(log: AuditLog): Promise<FastifyInstance> {
  const a = Fastify({ routerOptions: { maxParamLength: 256 } }); // as server.ts
  a.addHook('onRequest', async (req) => {
    // As the auth boundary does: every API request carries an actor (the local one when auth is off), or none.
    (req as { actor?: Actor | null }).actor = actor;
  });
  registerDeskSnoozeRoutes(a, { snoozes: new DeskSnoozes(log, () => clock) });
  await a.ready();
  return a;
}

/** A trail on the test's clock, as the daemon's is on its own. */
const trailAt = (path: string): AuditLog => new AuditLog(path, () => undefined, () => clock);

const key = 'run:290a7fee';
const url = (k: string): string => `/api/v1/desk/snoozes/${encodeURIComponent(k)}`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desk-snoozes-'));
  audit = trailAt(join(dir, 'audit.log'));
  clock = Date.parse('2026-11-24T12:00:00Z');
  actor = LOCAL_ACTOR;
  app = await serve(audit);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('crew#1124: snooze a Needs-you item', () => {
  it('PUT snoozes until a time, GET lists it, DELETE wakes it; each is audited', async () => {
    const until = '2026-11-24T13:00:00.000Z';
    const put = await app.inject({ method: 'PUT', url: url(key), payload: { until, severity: 70 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key, until, severity: 70, by: 'local', at: '2026-11-24T12:00:00.000Z' } satisfies Partial<DeskSnooze>);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse;
    expect(list.snoozes.map((s) => s.key)).toEqual([key]);
    const del = await app.inject({ method: 'DELETE', url: url(key) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ key, woken: true });
    expect(((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes).toEqual([]);
    await audit.flush();
    const trail = (await audit.readAll()).map((e) => [e.action, e.detail?.['key']]);
    expect(trail).toEqual([['desk.need.woken', key], ['desk.need.snoozed', key]]);
  });

  it('a snooze ends by itself at its time, and survives a restart until then', async () => {
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T14:00:00.000Z' } });
    await app.inject({ method: 'PUT', url: url('infra:disk'), payload: { until: '2026-11-24T12:30:00.000Z' } });
    await audit.flush();
    await app.close();
    app = await serve(trailAt(join(dir, 'audit.log')));
    clock = Date.parse('2026-11-24T13:00:00Z');
    const after = (await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse;
    expect(after.snoozes.map((s) => s.key)).toEqual([key]);
    expect(after.snoozes[0]!.severity).toBeNull();
  });

  it('a re-snooze replaces the earlier one; waking an unsnoozed key says so', async () => {
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T14:00:00.000Z' } });
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T12:10:00.000Z' } });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse;
    expect(list.snoozes).toHaveLength(1);
    expect(list.snoozes[0]!.until).toBe('2026-11-24T12:10:00.000Z');
    expect((await app.inject({ method: 'DELETE', url: url('run:nope') })).json()).toEqual({ key: 'run:nope', woken: false });
  });

  it('refuses a time in the past, past the 7-day bound, an unknown field or an over-long key', async () => {
    const bad = async (k: string, payload: unknown): Promise<number> => (await app.inject({ method: 'PUT', url: url(k), payload: payload as object })).statusCode;
    expect(await bad(key, { until: '2026-11-24T11:59:00.000Z' })).toBe(400);
    expect(await bad(key, { until: new Date(clock + DESK_SNOOZE_MAX_MS + 60_000).toISOString() })).toBe(400);
    expect(await bad(key, { until: 'tomorrow' })).toBe(400);
    expect(await bad(key, { until: '2026-11-24T13:00:00.000Z', severity: 'red' })).toBe(400);
    expect(await bad(key, { until: '2026-11-24T13:00:00.000Z', severity: 1.5 })).toBe(400);
    expect(await bad(key, { until: '2026-11-24T13:00:00.000Z', hide: true })).toBe(400);
    expect(await bad('x'.repeat(201), { until: '2026-11-24T13:00:00.000Z' })).toBe(400);
    expect(await bad(key, { until: new Date(clock + DESK_SNOOZE_MAX_MS).toISOString() })).toBe(200);
  });

  it('an agent can read the snoozes but never set or end one', async () => {
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T13:00:00.000Z' } });
    actor = AGENT;
    expect((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).statusCode).toBe(200);
    const put = await app.inject({ method: 'PUT', url: url('infra:disk'), payload: { until: '2026-11-24T13:00:00.000Z' } });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: 'human_operator_only' });
    expect((await app.inject({ method: 'DELETE', url: url(key) })).statusCode).toBe(403);
  });

  it('review r1: a request with no actor is refused, never taken for the local person', async () => {
    actor = null;
    const put = await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T13:00:00.000Z' } });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: 'human_operator_only' });
    expect((await app.inject({ method: 'DELETE', url: url(key) })).statusCode).toBe(403);
  });

  it('review r1: what a restart replays is what the routes answered (wake, re-snooze, wake then snooze)', async () => {
    const put = (k: string, until: string) => app.inject({ method: 'PUT', url: url(k), payload: { until } });
    await put('a', '2026-11-24T14:00:00.000Z');
    await app.inject({ method: 'DELETE', url: url('a') });
    await put('b', '2026-11-25T12:00:00.000Z');
    await put('b', '2026-11-24T12:20:00.000Z'); // the replacement ends sooner than the first
    await put('c', '2026-11-24T14:00:00.000Z');
    await app.inject({ method: 'DELETE', url: url('c') });
    await put('c', '2026-11-24T15:00:00.000Z');
    const live = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    expect(live.map((x) => [x.key, x.until])).toEqual([['b', '2026-11-24T12:20:00.000Z'], ['c', '2026-11-24T15:00:00.000Z']]);
    await app.close();
    app = await serve(trailAt(join(dir, 'audit.log')));
    const replay = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    expect(replay).toEqual(live); // every field, `at` included
    clock = Date.parse('2026-11-24T12:30:00Z'); // b's replacement ended; its first, longer snooze does not come back
    expect(((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes.map((x) => x.key)).toEqual(['c']);
  });

  it('review r1: a wake and a re-snooze racing the first load agree with the replay', async () => {
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T14:00:00.000Z' } });
    await app.close();
    app = await serve(trailAt(join(dir, 'audit.log')));
    await Promise.all([
      app.inject({ method: 'DELETE', url: url(key) }),
      app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T13:00:00.000Z' } }),
    ]);
    const live = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    await app.close();
    app = await serve(trailAt(join(dir, 'audit.log')));
    const replay = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    expect(replay).toEqual(live);
  });

  it('review r1: a snooze the trail could not record is a 500 and changes nothing', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const trail = join(dir, 'read-only.log');
    writeFileSync(trail, '');
    chmodSync(trail, 0o444); // readable, but no append lands
    await app.close();
    app = await serve(trailAt(trail));
    const put = await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T13:00:00.000Z' } });
    expect(put.statusCode).toBe(500);
    expect(put.json()).toMatchObject({ code: 'desk_snooze_unsaved' });
    expect(((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes).toEqual([]);
  });

  it('review r2: a wake the trail could not record is a 500, the snooze stays (live and after a restart), and the next change works', async () => {
    await app.inject({ method: 'PUT', url: url(key), payload: { until: '2026-11-24T14:00:00.000Z' } });
    const before = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    await app.close();
    // A deterministic failure seam: the real trail, whose durable append fails while `failing` is set.
    const real = trailAt(join(dir, 'audit.log'));
    let failing = true;
    const seam = {
      readAll: real.readAll.bind(real),
      recordDurable: async (...args: Parameters<AuditLog['recordDurable']>): Promise<number> => {
        if (failing) throw new Error('disk full');
        return real.recordDurable(...args);
      },
    } as unknown as AuditLog;
    app = await serve(seam);
    const del = await app.inject({ method: 'DELETE', url: url(key) });
    expect(del.statusCode).toBe(500);
    expect(del.json()).toMatchObject({ code: 'desk_snooze_unsaved' });
    expect(((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes).toEqual(before);
    failing = false; // the chain recovers: the next change lands
    expect((await app.inject({ method: 'DELETE', url: url(key) })).json()).toEqual({ key, woken: true });
    await app.close();
    app = await serve(trailAt(join(dir, 'audit.log')));
    expect(((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes).toEqual([]);
  });

  it('review r2: a snooze after a torn last line (a crash mid-write) is not lost with the fragment', async () => {
    const trail = join(dir, 'audit.log');
    await app.inject({ method: 'PUT', url: url('a'), payload: { until: '2026-11-24T14:00:00.000Z' } });
    await app.close();
    writeFileSync(trail, `${readFileSync(trail, 'utf8')}{"ts":1,"action":"desk.need.sno`); // no newline: a torn tail
    app = await serve(trailAt(trail));
    expect((await app.inject({ method: 'PUT', url: url('b'), payload: { until: '2026-11-24T15:00:00.000Z' } })).statusCode).toBe(200);
    await app.close();
    app = await serve(trailAt(trail));
    const replay = ((await app.inject({ method: 'GET', url: '/api/v1/desk/snoozes' })).json() as DeskSnoozesResponse).snoozes;
    expect(replay.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('review r2: a durable entry is heard by listeners only once it is on disk', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const trail = join(dir, 'read-only.log');
    writeFileSync(trail, '');
    chmodSync(trail, 0o444);
    const log = trailAt(trail);
    const heard: string[] = [];
    log.onRecord((e) => heard.push(e.action));
    await expect(log.recordDurable('desk.need.snoozed', LOCAL_ACTOR, { detail: { key } })).rejects.toThrow();
    expect(heard).toEqual([]);
    const ok = trailAt(join(dir, 'audit.log'));
    ok.onRecord((e) => heard.push(e.action));
    await ok.recordDurable('desk.need.snoozed', LOCAL_ACTOR, { detail: { key } });
    expect(heard).toEqual(['desk.need.snoozed']);
  });
});
