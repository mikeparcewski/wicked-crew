// Shared helpers for the K2b write-path tests: a harness over a fresh Postgres with K2b's writer logins as
// sources, Allow writes turned on, and an app whose spec holds the actions under test.

import { expect } from 'vitest';

import type { AppAction, AppActionPrepareResponse, AppActionRunResponse, AppDetail, AppQuery } from '../../src/core/types.js';
import { appsHarness, type Harness, specWith } from './apps-harness.js';
import type { FreshPg } from './sources-db.js';

export const LOGINS = {
  writer: { user: 'apps_k2b_writer', password: 'apps-k2b-writer' },
  colwriter: { user: 'apps_k2b_colwriter', password: 'apps-k2b-colwriter' },
  inserter: { user: 'apps_k2b_inserter', password: 'apps-k2b-inserter' },
  repl: { user: 'apps_k2b_repl', password: 'apps-k2b-repl' },
} as const;

export interface WriteRig {
  h: Harness;
  db: FreshPg;
  /** Land these actions (and queries) as the app's head; answers the landed version. */
  land(actions: AppAction[], queries?: AppQuery[], texts?: Record<string, string>): Promise<number>;
  grant(id: string, version?: number): Promise<{ status: number; body: Record<string, unknown> & { code?: string } }>;
  prepare(id: string, params?: Record<string, unknown>, version?: number): Promise<{ status: number; body: Record<string, unknown> & { code?: string } }>;
  run(id: string, record: string): Promise<{ status: number; body: Record<string, unknown> & { code?: string } }>;
  /** Grant (if needed), prepare and run; expects both calls to answer 200. */
  act(id: string, params?: Record<string, unknown>): Promise<{ card: AppActionPrepareResponse['card']; record: string; run: AppActionRunResponse }>;
  /** One value read as the superuser. */
  one(sql: string): Promise<string | null>;
  version: () => number;
}

export async function writeRig(db: FreshPg, sources: Array<keyof typeof LOGINS> = ['writer']): Promise<WriteRig> {
  const h = await appsHarness();
  for (const s of sources) {
    const login = LOGINS[s];
    await h.addPg(s, { port: db.port, database: db.database, user: login.user, password: login.password });
    const on = await h.call('PUT', `/sources/${s}/allow-writes`, { allowed: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  await h.newApp('desk');
  let head = 1;
  const rig: WriteRig = {
    h,
    db,
    version: () => head,
    async land(actions, queries = [], texts = {}) {
      const r = await h.land('desk', specWith(queries, actions), texts);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      head = (r.body as { app: AppDetail }).app.head.version;
      return head;
    },
    grant: (id, version = head) => h.call('POST', `/apps/desk/actions/${id}/grant`, { version }),
    prepare: (id, params, version = head) => h.call('POST', `/apps/desk/actions/${id}/prepare`, { version, ...(params !== undefined ? { params } : {}) }),
    run: (id, record) => h.call('POST', `/apps/desk/actions/${id}/run`, { record }),
    async act(id, params) {
      if (h.writePath.getGrant('desk', id) === null) {
        const g = await rig.grant(id);
        expect(g.status, JSON.stringify(g.body)).toBe(200);
      }
      const p = await rig.prepare(id, params);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const prepared = p.body as unknown as AppActionPrepareResponse;
      const r = await rig.run(id, prepared.record);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return { card: prepared.card, record: prepared.record, run: r.body as unknown as AppActionRunResponse };
    },
    async one(sql) {
      const rows = await db.admin.unsafe<Array<{ v: string | null }>>(sql);
      return rows[0]?.v ?? null;
    },
  };
  return rig;
}

/** An update of `table` setting `set`, keyed on `id` (a required integer parameter). */
export function updateAction(id: string, source: string, table: string, set: NonNullable<Extract<AppAction, { kind: 'row-write' }>['set']>, extra: Partial<Extract<AppAction, { kind: 'row-write' }>> = {}): AppAction {
  return {
    id,
    kind: 'row-write',
    source,
    table,
    op: 'update',
    set,
    key: { id: { kind: 'param', name: 'id' } },
    params: { type: 'object', properties: { id: { type: 'integer' }, ...(extra.params?.properties ?? {}) }, required: ['id', ...(extra.params?.required ?? [])] },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'params')),
  } as AppAction;
}
