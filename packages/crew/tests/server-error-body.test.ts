// crew#1359: a server error body carries no absolute path. A 500 answers a code and a generic message (the detail
// goes to the daemon log only); other 5xx bodies keep their shape with paths taken out. Over the REAL server assembly
// (createServer's hooks and Fastify's default error handler), not a bare Fastify.

import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { INTERNAL_ERROR_MESSAGE, internalErrorBody, redactPaths, sanitizeServerErrorBody } from '../src/api/server-error-body.js';
import { removeScratch } from './setup/scratch.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';

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
    // `unindexed`: its graph file does not exist. `locked`: the file exists (here a directory) and still cannot open.
    listRepos: async () => [
      { id: 'unindexed', name: 'unindexed', root_path: scratch, default_branch: 'main', registered_at: 1, code_graph_db: join(scratch, 'repo-graphs', 'unindexed', 'estate.db') },
      { id: 'locked', name: 'locked', root_path: scratch, default_branch: 'main', registered_at: 1, code_graph_db: scratch },
      { id: 'sealed', name: 'sealed', root_path: scratch, default_branch: 'main', registered_at: 1, code_graph_db: join(scratch, 'sealed', 'estate.db') },
    ],
    getCoverageReportForRepo: async () => {
      throw new Error(`storage error: unable to open database file: ${STATE}`);
    },
    getGraphKindsForRepo: async (repo: string) => {
      if (repo === 'unindexed' || repo === 'locked' || repo === 'sealed') throw new Error(`storage error: unable to open database file: ${STATE}`);
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

  it('a registered repo with no code graph yet is a 404 not_indexed, not a 500 (graph and coverage)', async () => {
    for (const url of ['/api/v1/governance/graph?repo=unindexed', '/api/v1/governance/coverage?repo=unindexed']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_indexed' });
      expect(res.body).not.toMatch(ABSOLUTE);
    }
  });

  it('(xreview r1/r2) a graph file that exists but cannot open, or sits under a folder that cannot be searched, is still a server error, not "not indexed"', async () => {
    const sealed = join(scratch, 'sealed');
    mkdirSync(sealed);
    chmodSync(sealed, 0o000);
    try {
      for (const repo of ['locked', ...(process.getuid?.() === 0 ? [] : ['sealed'])]) {
        const res = await app.inject({ method: 'GET', url: `/api/v1/governance/graph?repo=${repo}` });
        expect(res.statusCode, repo).toBe(500);
        expect(res.json()).toMatchObject({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error' });
        expect(res.body).not.toMatch(ABSOLUTE);
      }
    } finally {
      chmodSync(sealed, 0o755);
    }
  });
});

describe('redactPaths / internalErrorBody / sanitizeServerErrorBody', () => {
  it('takes out POSIX, file:, home-relative, dot-folder and Windows paths, and leaves URLs and route pointers', () => {
    expect(redactPaths(`open ${STATE} failed`)).toBe('open <path> failed');
    expect(redactPaths('at ~/x/y.db and D:\\a\\b.db and C:/Data/x/y.db')).toBe('at <path> and <path> and <path>');
    expect(redactPaths('file:/home/someone/.wicked-crew/state/estate.db')).toBe('file:<path>');
    expect(redactPaths('at /opt2/x/.wicked-crew/state/x.db')).toBe('at <path>');
    expect(redactPaths(`at ${homedir()}/.wicked-crew/a.db`)).toBe('at <path>');
    const pointers = 'see https://example.com/home/x, POST /api/v1/governance/rules, re-publish (POST /skills/publish), GET /runs/abc';
    expect(redactPaths(pointers)).toBe(pointers);
    expect(redactPaths('relative src/math.js stays')).toBe('relative src/math.js stays');
  });

  it("(xreview r2) a 500 keeps only the named structured fields (run ids, an MCP subject), never nested detail", () => {
    const body = internalErrorBody(
      JSON.stringify({
        error: `failed at ${STATE}`,
        message: 'm',
        runIds: ['r-1'],
        launched: 1,
        subject: 'mcp:estate/proposal.submit',
        ruleIds: ['POL-1/a'],
        reason: 'engine said: disk full',
        ledger: { errors: [{ id: 'd1', error: 'poisoned' }] },
        files: { [STATE]: false },
      }),
      'r9',
    );
    expect(body).toEqual({
      runIds: ['r-1'],
      launched: 1,
      subject: 'mcp:estate/proposal.submit',
      ruleIds: ['POL-1/a'],
      error: INTERNAL_ERROR_MESSAGE,
      code: 'internal_error',
      requestId: 'r9',
    });
  });

  it('(xreview r2) a state home outside the usual roots is matched literally', () => {
    const before = crewStateHome();
    setCrewStateHome('/customer-state');
    try {
      expect(redactPaths('open /customer-state/repo-graphs/app/estate.db failed')).toBe('open <path> failed');
    } finally {
      setCrewStateHome(before);
    }
  });

  it('keeps only a plain token code', () => {
    expect(internalErrorBody(JSON.stringify({ error: 'x', code: '/etc/passwd' }), 'r1').code).toBe('internal_error');
    expect(internalErrorBody('not json', 'r1')).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error', requestId: 'r1' });
  });

  it('(xreview r1) another 5xx is scrubbed on its decoded strings and stays valid JSON (quoted and Windows paths)', () => {
    const quoted = JSON.stringify({ error: `open estate store at "${STATE}": unable to open database file`, code: 'store' });
    const out = sanitizeServerErrorBody(502, quoted, 'r1')!;
    expect(JSON.parse(out.body)).toEqual({ error: 'open estate store at "<path>": unable to open database file', code: 'store' });
    const win = JSON.stringify({ error: 'skills root C:\\Users\\someone\\state\\skills is not seeded' });
    expect(JSON.parse(sanitizeServerErrorBody(503, win, 'r1')!.body)).toEqual({ error: 'skills root <path> is not seeded' });
    expect(sanitizeServerErrorBody(503, JSON.stringify({ error: 'no path here' }), 'r1')).toBeNull();
    // (xreview r2) a path in a key is taken out too
    expect(JSON.parse(sanitizeServerErrorBody(503, JSON.stringify({ files: { [STATE]: false } }), 'r1')!.body)).toEqual({ files: { '<path>': false } });
    expect(sanitizeServerErrorBody(404, quoted, 'r1')).toBeNull();
  });
});
