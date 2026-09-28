// A syntactically invalid JSON body is a 400 whose message carries none of the body — over the
// REAL server assembly (createServer's own application/json parser, Fastify's default error
// handler and its request log), not a bare Fastify.
//
// V8's JSON.parse message quotes the text around the bad token, so an unquoted value sent to
// `PUT /api/v1/mcp/servers/:name/secret` came back in the 400 and went to the daemon log
// (DES-MCP-TOOLS-001 D-2: a secret never appears in a response, log or file).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

const SECRET = 'sk-PARSEECHO-qzxvwjkq';

let scratch: string;
let app: FastifyInstance;
let savedLogLevel: string | undefined;
const logged: string[] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-json-parse-error-'));
  savedLogLevel = process.env['LOG_LEVEL'];
  // `info`: Fastify logs a 4xx error at info level, which is where the echo landed.
  process.env['LOG_LEVEL'] = 'info';
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

describe('an invalid JSON body', () => {
  it.each([
    ['an unquoted value', `{"value": ${SECRET}}`],
    ['a bare value', SECRET],
    ['a trailing token', `{"value": "x" ${SECRET}}`],
  ])('%s is a 400 that neither answers nor logs any of the body', async (_label, payload) => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let res;
    try {
      res = await app.inject({
        method: 'PUT',
        url: '/api/v1/mcp/servers/fx/secret',
        headers: { 'content-type': 'application/json' },
        payload,
      });
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toBe('the request body is not valid JSON');
    // Any 6-character run of the secret, so a truncated echo is caught too.
    for (let i = 0; i + 6 <= SECRET.length; i++) {
      const piece = SECRET.slice(i, i + 6);
      expect(res.body, piece).not.toContain(piece);
      expect(logged.join(''), piece).not.toContain(piece);
    }
  });
});
