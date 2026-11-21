// crew#1300: observers can inspect call metadata without any value from a row.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerAppRoutes } from '../src/apps/routes.js';
import { appsHarness, specWith } from './support/apps-harness.js';

describe('Apps call records', () => {
  it('answers an observer with two reads, oldest first, and never a row value', async () => {
    const h = await appsHarness({ extra: (app) => { app.get('/api/v1/runs', async () => ({ runs: [{ id: 'PRIVATE-ROW-VALUE' }] })); } });
    try {
      await h.newApp('desk');
      expect((await h.land('desk', specWith([{ id: 'runs', source: 'crew', kind: 'crew', rowPath: '$.runs[*]', output: [{ name: 'id', type: 'string' }] }]), { runs: JSON.stringify({ route: '/runs' }) })).status).toBe(200);
      for (const as of ['priya', 'sam']) expect((await h.call('POST', '/apps/desk/query', { version: 2, query: 'runs' }, as)).status).toBe(200);
      const r = await h.call('GET', '/apps/desk/calls', undefined, 'olga');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ app: 'desk', records: [
        { viewer: 'priya', query: 'runs', rows: 1, outcome: 'ok' },
        { viewer: 'sam', query: 'runs', rows: 1, outcome: 'ok' },
      ] });
      expect(JSON.stringify(r.body)).not.toContain('PRIVATE-ROW-VALUE');
      expect((await h.call('GET', '/apps/missing/calls')).status).toBe(404);
    } finally { await h.close(); }
  });

  it('answers 501 without an executor and 404 for an unknown app', async () => {
    const h = await appsHarness();
    const app = Fastify();
    try {
      await h.newApp('desk');
      registerAppRoutes(app, { store: h.store, audit: h.audit });
      expect((await app.inject('/api/v1/apps/desk/calls')).statusCode).toBe(501);
      expect((await app.inject('/api/v1/apps/missing/calls')).statusCode).toBe(404);
    } finally { await app.close(); await h.close(); }
  });
});
