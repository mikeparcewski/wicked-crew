// C3-crew (DES-studio-rebuild §C3; DESIGN-interaction rule 6): the engine's `elicitationCreated`
// carries `recommended` — the index of the option the PRODUCER of the options recommends — and crew
// relays it on `GET /runs/:id/elicitation`. Absent ⇒ nothing preselected; an index that names no
// option (or rides a free-text elicitation) is dropped, never clamped.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache, recommendedIndex } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';

const created = (extra: Record<string, unknown>): CoreEvent =>
  ({ type: 'elicitationCreated', session: 'r1', epoch: 1, elicitationId: 'e1', message: 'Which plan?', propType: 'string', ...extra }) as unknown as CoreEvent;

describe('recommendedIndex', () => {
  it('keeps an integer index that names one of the options', () => {
    expect(recommendedIndex(0, ['a', 'b'])).toBe(0);
    expect(recommendedIndex(1, ['a', 'b'])).toBe(1);
  });
  it('drops an out-of-range, negative, fractional or non-number index, and any index on free text', () => {
    for (const raw of [2, -1, 0.5, '1', null, undefined, Number.NaN]) expect(recommendedIndex(raw, ['a', 'b'])).toBeUndefined();
    expect(recommendedIndex(0, null)).toBeUndefined();
    expect(recommendedIndex(0, [])).toBeUndefined();
  });
});

describe('the elicitation cache relays the producer\'s recommendation (C3)', () => {
  it('elicitationCreated{recommended} → the entry carries it', () => {
    const cache = new ElicitationCache();
    cache.ingest(created({ options: ['Ship it', 'Hold'], recommended: 1 }));
    expect(cache.get('r1')).toMatchObject({ options: ['Ship it', 'Hold'], recommended: 1 });
  });
  it('absent stays absent (no key at all), and a bad index is dropped', () => {
    const cache = new ElicitationCache();
    cache.ingest(created({ options: ['a', 'b'] }));
    expect(cache.get('r1')).not.toHaveProperty('recommended');
    cache.ingest(created({ elicitationId: 'e2', options: ['a', 'b'], recommended: 5 }));
    expect(cache.get('r1')).not.toHaveProperty('recommended');
    cache.ingest(created({ elicitationId: 'e3', options: null, recommended: 0 }));
    expect(cache.get('r1')).not.toHaveProperty('recommended');
  });
  it('a stale-tab restore keeps the recommendation', () => {
    const cache = new ElicitationCache();
    cache.ingest(created({ options: ['a', 'b'], recommended: 0 }));
    const taken = cache.take('r1')!;
    expect(cache.restoreIfUnchanged('r1', taken.entry, taken.gen)).toBe(true);
    expect(cache.get('r1')).toMatchObject({ recommended: 0 });
  });
});

describe('GET /runs/:id/elicitation serves `recommended` (C3)', () => {
  let app: FastifyInstance;
  let cache: ElicitationCache;

  beforeEach(async () => {
    cache = new ElicitationCache();
    app = Fastify({ logger: false });
    registerRoutes(app, { sessions: vi.fn(async () => ['r1']), sessionsDetail: vi.fn(async () => []), listRepos: vi.fn(async () => []) } as unknown as CoreAdapter, new GateCache(), cache);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('with a recommendation', async () => {
    cache.ingest(created({ options: ['Ship it', 'Hold'], recommended: 0 }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/elicitation' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId: 'r1', elicitationId: 'e1', options: ['Ship it', 'Hold'], recommended: 0 });
  });
  it('without one: the key is absent (nothing preselected)', async () => {
    cache.ingest(created({ options: ['Ship it', 'Hold'] }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/elicitation' });
    expect(res.json()).not.toHaveProperty('recommended');
  });
});
