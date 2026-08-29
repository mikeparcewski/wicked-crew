/**
 * Fixture harness for the GENERATED API suites (TH-11) — hand-written, committed.
 *
 * The generator (scripts/generate-api-tests.ts) derives WHICH cases exist from the committed
 * endpoint manifest; this module supplies the one thing a manifest cannot: a running route set
 * with known state. Same seams as every route unit test in this suite (registerRoutes over a
 * mock adapter, fastify inject, no NAPI engine), plus two fixture runs whose statuses the
 * generated negatives depend on:
 *
 *   - `run-fixture-done`  — status `completed`:      POST gate on it answers 409 (not awaiting).
 *   - `run-fixture-gated` — status `awaiting_human`: POST gate on it resolves (positive case).
 *
 * Both ids are load-bearing: the generator writes them into the emitted tests. Rename them here
 * and regenerate, never edit the generated file.
 */
import Fastify from 'fastify';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { registerRoutes } from '../../src/api/routes.js';
import { GateCache } from '../../src/api/gate-cache.js';
import { ElicitationCache } from '../../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { SessionView } from '../../src/core/types.js';

export const RUN_DONE = 'run-fixture-done';
export const RUN_GATED = 'run-fixture-gated';

function view(id: string, status: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'generated-suite fixture',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

/** The route set the generated tests inject against. Build one per test file. */
export function buildGeneratedApiApp(): FastifyInstance {
  const adapter = {
    ping: vi.fn(async () => 'pong'),
    sessionsDetail: vi.fn(async () => [view(RUN_DONE, 'completed'), view(RUN_GATED, 'awaiting_human')]),
    sessions: vi.fn(async () => [RUN_DONE, RUN_GATED]),
    launchRun: vi.fn(async () => 'run-generated'),
    confirmGate: vi.fn(async () => 'running'),
  } as unknown as CoreAdapter;

  const app = Fastify({ logger: false });
  // Same tolerant empty-JSON-body parser createServer installs — some POSTs take no body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined || body === null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache());
  return app;
}
