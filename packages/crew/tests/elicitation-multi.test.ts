// Guided asks (api-types 0.158.0): a multi-select elicitation, end to end through crew — the engine's frame carries
// `multi`, the cache keeps it (only when well-formed), GET relays it, and POST takes `content.values`: distinct
// options, within the bounds, forwarded to the engine as the JSON array of the picks in option order.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache, multiBounds } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';

const RUN = 'run-multi-01';
const EID = 'ask-multi-01';
const OPTIONS = ['main', 'release/2026.10', 'develop'];

function frame(multi: unknown): Record<string, unknown> {
  return { type: 'elicitationCreated', session: RUN, elicitationId: EID, message: 'Which branches?', options: OPTIONS, propType: 'array', multi };
}

describe('multiBounds', () => {
  it('keeps well-formed bounds and drops everything else', () => {
    expect(multiBounds({ min: 1, max: 2 }, OPTIONS)).toEqual({ min: 1, max: 2 });
    expect(multiBounds({ min: 1, max: 3 }, OPTIONS)).toEqual({ min: 1, max: 3 });
    for (const bad of [undefined, null, 'x', { min: 0, max: 2 }, { min: 2, max: 1 }, { min: 1, max: 4 }, { min: 1 }, { min: 1.5, max: 2 }]) {
      expect(multiBounds(bad, OPTIONS)).toBeUndefined();
    }
    expect(multiBounds({ min: 1, max: 1 }, null)).toBeUndefined();
  });
});

describe('a multi-select elicitation through the routes', () => {
  let cache: ElicitationCache;
  let adapter: { sessions: Mock; resolveElicitation: Mock };
  let app: FastifyInstance;

  beforeEach(async () => {
    cache = new ElicitationCache();
    adapter = { sessions: vi.fn().mockResolvedValue([RUN]), resolveElicitation: vi.fn().mockResolvedValue(undefined) };
    app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), cache);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const post = (content: unknown) => app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/elicitation`, payload: { elicitationId: EID, action: 'accept', content } });

  it('GET relays the bounds from the engine frame; a malformed multi is not relayed', async () => {
    cache.ingest(frame({ min: 1, max: 2 }) as never);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/elicitation` });
    expect(res.json()).toMatchObject({ options: OPTIONS, multi: { min: 1, max: 2 } });
    cache.ingest(frame({ min: 3, max: 2 }) as never);
    const bad = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/elicitation` });
    expect(bad.json().multi).toBeUndefined();
  });

  it('accepts values and forwards the picks in option order as a JSON array', async () => {
    cache.ingest(frame({ min: 1, max: 2 }) as never);
    const res = await post({ values: ['develop', 'main'] });
    expect(res.statusCode).toBe(200);
    expect(adapter.resolveElicitation).toHaveBeenCalledWith(RUN, EID, 'accept', '["main","develop"]');
    expect(cache.get(RUN)).toBeUndefined();
  });

  it.each([
    [{ values: ['main', 'nope'] }, 'among the allowed options'],
    [{ values: ['main', 'main'] }, 'each option once'],
    [{ values: ['main', 'develop', 'release/2026.10'] }, 'pick 1 to 2'],
    [{ response: 'main' }, 'content.values'],
  ])('refuses %j with a 400 and keeps the question open', async (content, words) => {
    cache.ingest(frame({ min: 1, max: 2 }) as never);
    const res = await post(content);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(words);
    expect(adapter.resolveElicitation).not.toHaveBeenCalled();
    expect(cache.get(RUN)?.elicitationId).toBe(EID);
  });

  it('refuses values on a single-choice question, and an empty values list', async () => {
    cache.ingest({ ...frame(undefined), propType: 'string' } as never);
    expect(cache.get(RUN)?.multi).toBeUndefined();
    const res = await post({ values: ['main'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('content.response');
    const empty = await post({ values: [] });
    expect(empty.statusCode).toBe(400);
    expect(adapter.resolveElicitation).not.toHaveBeenCalled();
  });
});
