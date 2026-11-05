// crew#1359: a server error body carries no absolute path. A 500 answers a code and a generic message (the detail
// goes to the daemon log only); other 5xx bodies keep their shape with paths taken out. Over the REAL server assembly
// (createServer's hooks and Fastify's default error handler), not a bare Fastify.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { INTERNAL_ERROR_MESSAGE, internalErrorBody, redactPaths } from '../src/api/server-error-body.js';
import { removeScratch } from './setup/scratch.js';

const STATE = '/home/someone/.wicked-crew/state/repos/app-one/graph.db';
const ABSOLUTE = /(^|[\s"'(=])(\/(Users|home|private|var|tmp|srv)\/|[A-Za-z]:\\)/u;

let scratch: string;
let app: FastifyInstance;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-server-error-body-'));
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
    // The engine's own message names the store file it could not open (what the rig answered).
    getGraphKindsForRepo: async (repo: string) => {
      if (repo === 'unindexed') throw new Error(`storage error: unable to open database file: ${STATE}`);
      throw new Error(`storage error: disk I/O error at ${STATE}`);
    },
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  app.get('/__test/throws', async () => {
    throw new Error(`boom reading ${STATE}`);
  });
  app.get('/__test/503', async (_req, reply) => reply.code(503).send({ error: `source down: config at ${STATE} unreadable; see /api/v1/sources`, code: 'source_unavailable' }));
  app.get('/__test/500-coded', async (_req, reply) => reply.code(500).send({ error: `failed at C:\\Users\\someone\\state\\x.db`, code: 'store_failed' }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  removeScratch(scratch);
});

describe('a server error body', () => {
  it('a forced 500 answers a code and a generic message, no absolute path (a route that sent the engine message)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/governance/graph?repo=broken' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(ABSOLUTE);
    expect(res.body).not.toContain('.wicked-crew');
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error', requestId: expect.any(String) });
  });

  it('a thrown error that reaches the default handler is covered too', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/throws' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(ABSOLUTE);
    expect(res.json()).toMatchObject({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error' });
  });

  it("a route's own code token survives; its message does not", async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/500-coded' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(ABSOLUTE);
    expect(res.json()).toMatchObject({ error: INTERNAL_ERROR_MESSAGE, code: 'store_failed' });
  });

  it('another 5xx keeps its code and message, with the path taken out and an /api pointer kept', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/503' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(ABSOLUTE);
    expect(res.json()).toEqual({ error: 'source down: config at <path> unreadable; see /api/v1/sources', code: 'source_unavailable' });
  });

  it('a registered repo with no code graph yet is a 404 not_indexed, not a 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/governance/graph?repo=unindexed' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_indexed' });
    expect(res.body).not.toMatch(ABSOLUTE);
  });
});

describe('redactPaths / internalErrorBody', () => {
  it('takes out POSIX, home-relative and Windows paths, and leaves URLs and /api routes', () => {
    expect(redactPaths(`open ${STATE} failed`)).toBe('open <path> failed');
    expect(redactPaths('at ~/x/y.db and D:\\a\\b.db')).toBe('at <path> and <path>');
    expect(redactPaths('see https://example.com/a/b and POST /api/v1/governance/rules')).toBe('see https://example.com/a/b and POST /api/v1/governance/rules');
    expect(redactPaths('relative src/math.js stays')).toBe('relative src/math.js stays');
  });

  it("keeps a 500's structured fields (paths taken out) and drops its free text", () => {
    const body = internalErrorBody(JSON.stringify({ error: `failed at ${STATE}`, message: 'm', runIds: ['r-1'], where: STATE }), 'r9');
    expect(body).toEqual({ runIds: ['r-1'], where: '<path>', error: INTERNAL_ERROR_MESSAGE, code: 'internal_error', requestId: 'r9' });
  });

  it('keeps only a plain token code', () => {
    expect(internalErrorBody(JSON.stringify({ error: 'x', code: '/etc/passwd' }), 'r1').code).toBe('internal_error');
    expect(internalErrorBody('not json', 'r1')).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error', requestId: 'r1' });
  });
});
