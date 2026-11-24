// crew#1124 (DES-desk-v2 §6 item 6): snooze a Needs-you item. The Desk's other five data asks are served
// (`/roster/record`); snooze was the one with no route, so a person could only answer or archive a need, never
// defer it. A snooze is a durable fact in the audit trail (`desk.need.snoozed` / `desk.need.woken`): it survives a
// restart, it ends by itself, and only a human operator sets or ends one (an agent cannot hide a need from a person).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DeskSnooze, DeskSnoozesResponse } from 'wicked-crew-api-types';

import { AuditLog } from '../src/api/audit.js';
import { DESK_SNOOZE_MAX_MS, DeskSnoozes, registerDeskSnoozeRoutes } from '../src/api/desk-snoozes.js';

const AGENT: Actor = { id: 'seat-1', kind: 'agent', trust: 'operator' } as Actor;

let dir: string;
let audit: AuditLog;
let clock: number;
let app: FastifyInstance;
let actor: Actor | undefined;

async function serve(log: AuditLog): Promise<FastifyInstance> {
  const a = Fastify({ routerOptions: { maxParamLength: 256 } }); // as server.ts
  a.addHook('onRequest', async (req) => {
    if (actor !== undefined) (req as { actor?: Actor }).actor = actor;
  });
  registerDeskSnoozeRoutes(a, { snoozes: new DeskSnoozes(log, () => clock), audit: log });
  await a.ready();
  return a;
}

const key = 'run:290a7fee';
const url = (k: string): string => `/api/v1/desk/snoozes/${encodeURIComponent(k)}`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desk-snoozes-'));
  audit = new AuditLog(join(dir, 'audit.log'));
  clock = Date.parse('2026-11-24T12:00:00Z');
  actor = undefined;
  app = await serve(audit);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('crew#1124: snooze a Needs-you item', () => {
  it('PUT snoozes until a time, GET lists it, DELETE wakes it; each is audited', async () => {
    const until = '2026-11-24T13:00:00.000Z';
    const put = await app.inject({ method: 'PUT', url: url(key), payload: { until, severity: 'red' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key, until, severity: 'red', by: 'local', at: '2026-11-24T12:00:00.000Z' } satisfies Partial<DeskSnooze>);
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
    app = await serve(new AuditLog(join(dir, 'audit.log')));
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
});
