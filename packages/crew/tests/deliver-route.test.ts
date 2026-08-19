// crew#293 — POST /runs accepts deliver:"pr" and threads it to the adapter.
//
// Fastify inject() with a stub adapter (no NAPI): the route's job is to parse, validate, and
// hand the option to CoreAdapter.launchRun — composition itself is covered by
// deliver-launch.test.ts. `clisJson` is always supplied so the route never consults the real
// council roster.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  launchRun: ReturnType<typeof vi.fn>;
};

function buildApp(mockAdapter: MockAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
  );
  return app;
}

describe('POST /runs deliver option (crew#293)', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = { launchRun: vi.fn().mockResolvedValue('run-1') };
    app = buildApp(mockAdapter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts deliver:"pr" with a workflow and threads it to launchRun', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature', deliver: 'pr' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: 'run-1' });

    expect(mockAdapter.launchRun).toHaveBeenCalledTimes(1);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.workflow).toBe('feature');
    expect(input.deliver).toBe('pr');
  });

  it('omitting deliver leaves the field off the adapter input entirely', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature' },
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
  });

  it('400 on deliver without a workflow — nothing launches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', deliver: 'pr' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details?: { message?: string }[] };
    // The refine's message names the requirement so the caller can fix the request.
    expect(JSON.stringify(body)).toContain('requires a workflow');
    expect(mockAdapter.launchRun).not.toHaveBeenCalled();
  });

  it('400 on an unknown deliver mode — "pr" is the only one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature', deliver: 'branch' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockAdapter.launchRun).not.toHaveBeenCalled();
  });
});
